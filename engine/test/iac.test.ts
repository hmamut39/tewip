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
