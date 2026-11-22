// Phase 134: `tewip infra`, measured against 46 real Dockerfiles and 41 real compose files.
//
// Container scanners report two things: CVEs in the base image, which needs a registry and a
// feed, and "best practices", which is a long list of opinions. This does neither. It reports
// what is certain from the text and changes what an attacker can reach once inside, and it says
// plainly that the rest of the category was not looked at.
//
// Two of the rules below exist in the shape they do because the corpus corrected them.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readDockerfile } from '../iac/dockerfile.ts';
import { readCompose } from '../iac/compose.ts';
import { renderIac, scanIac } from '../iac/iac-command.ts';
import { ships } from '../ships.ts';

const NL = String.fromCharCode(10);
const file = (...lines: string[]) => lines.join(NL) + NL;
const rules = (fs: Array<{ rule: string }>) => fs.map((f) => f.rule).sort();

describe('what a Dockerfile lets in', () => {
  it('says an image with no USER runs as root', () => {
    const found = readDockerfile('Dockerfile', file('FROM node:22-alpine', 'COPY . /app', 'CMD ["node", "server.js"]'));
    assert.deepEqual(rules(found), ['runs-as-root']);
    assert.equal(found[0].risk, 'high');
  });

  it('does not, when the image sets one', () => {
    const found = readDockerfile('Dockerfile', file('FROM node:22-alpine', 'USER node', 'CMD ["node", "server.js"]'));
    assert.deepEqual(rules(found), []);
  });

  it('reads only the last stage, because a builder ships nothing', () => {
    // A root builder followed by a non-root runtime is the correct pattern, and calling it
    // "runs as root" would teach people to ignore the rule.
    const found = readDockerfile(
      'Dockerfile',
      file('FROM golang:1.23 AS build', 'RUN go build -o /app', 'FROM gcr.io/distroless/static:nonroot AS runtime', 'USER nonroot', 'COPY --from=build /app /app'),
    );
    assert.deepEqual(rules(found), []);
  });

  it('is not reassured by a USER that belongs to an earlier stage', () => {
    // The case that actually distinguishes reading the last stage from reading the file. The
    // builder drops to a user; the stage that ships never does, so the shipped image is root.
    // The first version of the test above passed either way and proved nothing about staging.
    const found = readDockerfile(
      'Dockerfile',
      file('FROM golang:1.23 AS build', 'USER builder', 'RUN go build -o /app', 'FROM ubuntu:24.04 AS runtime', 'COPY --from=build /app /app', 'CMD ["/app"]'),
    );
    assert.deepEqual(rules(found), ['runs-as-root']);
  });

  it('does not call a reference to an earlier stage an unpinned base image', () => {
    // immich's machine-learning image ends `FROM prod-${DEVICE} AS prod`, which pulls nothing.
    // Without this, every multi-stage Dockerfile reports a finding: 7 of the corpus's findings
    // were this, and all 7 were wrong.
    const found = readDockerfile('Dockerfile', file('FROM python:3.12 AS prod-cpu', 'FROM prod-cpu AS prod', 'USER app'));
    assert.deepEqual(rules(found), []);
  });

  it('says nothing about a base image whose name is interpolated', () => {
    // `FROM ${REGISTRY}/base` cannot be resolved here, and a guess either way is invented.
    assert.deepEqual(rules(readDockerfile('Dockerfile', file('FROM ${REGISTRY}/base', 'USER app'))), []);
  });

  it('catches a base image pinned to nothing, or to latest', () => {
    assert.deepEqual(rules(readDockerfile('D', file('FROM ubuntu', 'USER app'))), ['unpinned-base']);
    assert.deepEqual(rules(readDockerfile('D', file('FROM gcr.io/distroless/cc-debian13:latest', 'USER app'))), ['unpinned-base']);
    assert.deepEqual(rules(readDockerfile('D', file('FROM ubuntu@sha256:abc123', 'USER app'))), [], 'a digest is the strongest pin there is');
    assert.deepEqual(rules(readDockerfile('D', file('FROM scratch', 'USER app'))), [], 'scratch is not an image anybody publishes');
  });

  it('catches a download piped into a shell, across a line continuation', () => {
    // Keycloak's edb container does exactly this, and the pipe is on the third physical line of
    // one RUN. Reading lines without joining continuations misses every real instance.
    const found = readDockerfile(
      'Dockerfile',
      file('FROM ubuntu:24.04', 'RUN export TOKEN=$(cat /run/secrets/t) && \\', '    (curl -1sSLf "https://downloads.example.test/$TOKEN/setup.sh" | bash) && \\', '    apt-get install -y thing', 'USER app'),
    );
    assert.deepEqual(rules(found), ['pipe-to-shell']);
  });

  it('catches ADD fetching over the network', () => {
    assert.deepEqual(rules(readDockerfile('D', file('FROM ubuntu:24.04', 'ADD https://example.test/x.tar.gz /tmp/', 'USER app'))), ['add-from-url']);
    assert.deepEqual(rules(readDockerfile('D', file('FROM ubuntu:24.04', 'COPY ./x.tar.gz /tmp/', 'USER app'))), [], 'COPY from the build context is the right way');
  });
});

describe('what a compose file hands a container', () => {
  it('catches the Docker socket, which is the whole host', () => {
    const found = readCompose('docker-compose.yml', file('services:', '  grafana:', '    volumes:', '      - /var/run/docker.sock:/var/run/docker.sock'));
    assert.deepEqual(rules(found), ['docker-socket']);
    assert.equal(found[0].risk, 'high');
  });

  it('catches privileged and host networking', () => {
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    privileged: true'))), ['privileged']);
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    network_mode: host'))), ['host-network']);
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    privileged: false'))), [], 'false is the right answer, not a finding');
  });

  it('reads a capability added, and not one dropped', () => {
    // `cap_drop: [SYS_ADMIN]` is a container doing the right thing. Reporting it would be
    // exactly backwards, and a line-by-line rule gets it backwards unless it tracks the key.
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    cap_add:', '      - SYS_ADMIN'))), ['dangerous-capability']);
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    cap_drop:', '      - SYS_ADMIN'))), []);
  });

  it('reads the inline capability list, which is the form the Compose reference uses', () => {
    // This was a real miss, found by eval/container-recall.ts: the rule only ever read the block
    // form, because the line that set the block flag consumed `cap_add:` before any rule saw it.
    // `cap_add: ["SYS_ADMIN"]` grants exactly what the block form grants.
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    cap_add: ["SYS_ADMIN"]'))), ['dangerous-capability']);
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    cap_add: [SYS_ADMIN, NET_ADMIN]'))), ['dangerous-capability'], 'unquoted, and one finding for the line');
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', "    cap_add: ['SYS_PTRACE']"))), ['dangerous-capability']);
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    cap_add: ["CHOWN"]'))), [], 'CHOWN is not one of the five');
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    cap_add: []'))), [], 'an empty list grants nothing');
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    cap_drop: ["SYS_ADMIN"]'))), [], 'inline, and still the opposite of a grant');
    // The shape that matters most: hardening and a grant on consecutive lines. Only the grant.
    const both = readCompose('c.yml', file('services:', '  a:', '    cap_drop: ["ALL"]', '    cap_add: ["NET_ADMIN"]'));
    assert.deepEqual(rules(both), ['dangerous-capability']);
    assert.ok(both[0].evidence.includes('cap_add'), `the finding should point at the grant, not the drop: ${both[0].evidence}`);
  });

  // `readCompose` and `readDockerfile` are exported, so their contract has to hold for whatever
  // text a caller hands them - not only for text that `scanIac` has already normalised.
  //
  // Worth stating explicitly because the parity test cannot see this: `iac-command.ts` turns every
  // file into LF before either reader is called, so putting the old newline-only split back changes
  // nothing it measures. Sabotaging it proved exactly that, which is how this test came to exist.
  it('reads a CRLF file the same as an LF one, called directly', () => {
    const CR = String.fromCharCode(13);
    const both = (lines: string[]) => [
      rules(readCompose('c.yml', lines.join(String.fromCharCode(10)) + String.fromCharCode(10))),
      rules(readCompose('c.yml', lines.join(CR + String.fromCharCode(10)) + CR + String.fromCharCode(10))),
    ];
    for (const lines of [
      ['services:', '  a:', '    cap_add:', '      - SYS_ADMIN'],
      ['services:', '  a:', '    cap_add: ["SYS_ADMIN"]'],
      ['services:', '  a:', '    privileged: true'],
      ['services:', '  a:', '    cap_drop:', '      - SYS_ADMIN'],
    ]) {
      const [lf, crlf] = both(lines);
      assert.deepEqual(crlf, lf, `CRLF and LF disagree on ${JSON.stringify(lines)}`);
    }
  });

  it('does not read a rule written in a comment as a finding', () => {
    assert.deepEqual(rules(readCompose('c.yml', file('services:', '  a:', '    # never set privileged: true here', '    image: x:1'))), []);
  });
});

describe('the report', () => {
  const project = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-iac-'));
    for (const [path, body] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body, 'utf8');
    }
    return root;
  };

  it('keeps a devcontainer apart from what ships', () => {
    // n8n's codespaces devcontainer runs privileged, which is usually deliberate. Printing it
    // beside a privileged production service teaches a reader to skim both.
    const scan = scanIac(project({
      '.devcontainer/docker-compose.yml': file('services:', '  dev:', '    privileged: true'),
      'docker-compose.yml': file('services:', '  app:', '    privileged: true'),
    }));
    assert.equal(scan.findings.filter((f) => f.ships).length, 1);
    assert.equal(scan.findings.filter((f) => !f.ships).length, 1);
    const page = renderIac(scan);
    assert.match(page, /## In what ships/);
    assert.match(page, /## In development and test setups/);
  });

  it('refuses to read silence as a clean bill of health', () => {
    const page = renderIac(scanIac(project({ 'Dockerfile': file('FROM node:22-alpine', 'USER node') })));
    assert.match(page, /not a clean bill of health/);
    assert.match(page, /vulnerabilities in the base images/, 'what it cannot do is in the report, not only in the docs');
    assert.match(page, /Kubernetes/, 'including the part it has no real data for');
  });
});

// Phase 212. "Your container runs as root" is a sentence somebody takes to their platform team, so
// it has to be true. Found by reading what `infra` says about immich rather than counting it.
describe('who the container actually runs as', () => {
  const NL = String.fromCharCode(10);
  const rootFindings = (...lines: string[]) => readDockerfile('Dockerfile', lines.join(NL)).filter((f) => f.rule === 'runs-as-root');

  it('follows USER back to the stage this one is built FROM', () => {
    // Docker inherits USER from the parent stage. Reading only the final stage does not, so this
    // image - which runs as `node` - was accused of running as root, at high severity.
    const found = rootFindings('FROM node:22 AS base', 'USER node', 'FROM base AS prod', 'COPY . .');
    assert.deepEqual(found, [], 'a USER inherited from the parent stage is the USER in force');
  });

  it('still names an inherited root, which is inherited just the same', () => {
    const found = rootFindings('FROM node:22 AS base', 'USER root', 'FROM base AS prod', 'COPY . .');
    assert.equal(found.length, 1, 'inheriting root is still running as root');
    assert.match(found[0].what, /the last USER in this image is root/);
  });

  it("lets the final stage's own USER win over the one it inherits", () => {
    assert.deepEqual(rootFindings('FROM node:22 AS base', 'USER root', 'FROM base AS prod', 'USER app'), []);
  });

  it('still names an image that sets no USER anywhere in the file', () => {
    // immich's machine-learning image, which really does run as root: the fix must not quieten it.
    const found = rootFindings('FROM python:3.13 AS prod-cpu', 'RUN pip install x', 'FROM prod-cpu AS prod', 'COPY . .');
    assert.equal(found.length, 1, 'no USER in any stage of the chain is still a finding');
  });

  it('does not loop when two stages name each other', () => {
    // `FROM a AS b` / `FROM b AS a` is not valid Docker, but a reader handed it must not hang.
    assert.doesNotThrow(() => rootFindings('FROM b AS a', 'FROM a AS b', 'COPY . .'));
  });

  it('files each finding under the sentence that is true of it', () => {
    // The report grouped by rule id and printed the first `what` over all of them, so a finding
    // whose sentence is "the last USER is root" was listed under "this image has no USER" with
    // the line `USER root` beside it as evidence - a heading its own quote contradicts.
    const root = mkdtempSync(join(tmpdir(), 'tewip-iac-group-'));
    writeFileSync(join(root, 'Dockerfile'), ['FROM node:22 AS prod', 'COPY . .'].join(NL), 'utf8');
    writeFileSync(join(root, 'Dockerfile.two'), ['FROM node:22 AS prod', 'USER root'].join(NL), 'utf8');
    const doc = renderIac(scanIac(root));
    assert.match(doc, /### this image has no USER[^\n]*\(1\)/, 'the image with no USER is counted on its own sentence');
    assert.match(doc, /### the last USER in this image is root[^\n]*\(1\)/, 'and the one that sets root on its own');
  });
});

// Phase 213. "What this project ships" has to mean it, and two commands were answering differently:
// `infra` asked by path and `sbom` never asked at all.
describe('what counts as shipping', () => {
  it('reads the filename as well as the path', () => {
    // immich's devcontainer is `server/Dockerfile.dev`, not `.devcontainer/Dockerfile`, so a path
    // test could not see it. The name says the same thing and is as reliable a convention.
    assert.equal(ships('server/Dockerfile'), true);
    assert.equal(ships('server/Dockerfile.dev'), false);
    assert.equal(ships('.devcontainer/Dockerfile'), false);
    assert.equal(ships('compose.dev.yaml'), false);
    assert.equal(ships('docker-compose.yml'), true);
  });

  it('does not take a file that merely contains the letters', () => {
    // The marker has to be a whole dot-separated part, or `latest.yml` becomes a test fixture.
    assert.equal(ships('deploy/latest.yml'), true);
    assert.equal(ships('config/devise.yml'), true);
  });

  it('keeps a development image out of the ships section and still shows it', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-ships-'));
    const NL = String.fromCharCode(10);
    writeFileSync(join(root, 'Dockerfile'), ['FROM node:22 AS prod', 'COPY . .'].join(NL), 'utf8');
    writeFileSync(join(root, 'Dockerfile.dev'), ['FROM node:22 AS dev', 'USER root'].join(NL), 'utf8');
    const doc = renderIac(scanIac(root));
    assert.match(doc, /## In what ships — 1/, 'only the shipping image counts against what ships');
    assert.match(doc, /## In development and test setups — 1/, 'and the development one is still shown, not dropped');
  });
});
