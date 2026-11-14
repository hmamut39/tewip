// What `tewip infra` finds in a Dockerfile and a Compose file, measured against Docker's own docs.
//
// The last unmeasured part of `infra`. Phase 160 measured the Kubernetes rules against the Pod
// Security Standards and found two gaps; Phase 165 measured the Terraform rules against AWS's
// guidance and found none. These eight - four in a Dockerfile, four in Compose - had no recall
// number at all.
//
// Ground truth is what Docker publishes: the Dockerfile best-practices page on USER and on pinning
// a tag, and the security pages on privileged containers, the daemon socket and added capabilities.
// Named rather than numbered, because CIS Docker numbering drifts the way CIS Kubernetes and CIS
// AWS do, and an identifier that is right for one version is wrong for the reader on another.
//
// Each control is planted twice, in the shape the documentation warns against and the shape it
// recommends. The second half is not a formality here: the Kubernetes capability rule once
// reported `drop: ["ALL"]` - the strongest hardening a pod spec can state - as a danger, 57 times
// on Google's microservices-demo, and the Compose rule is written in the same shape that bug had.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIac } from '../engine/iac/iac-command.ts';

const NL = String.fromCharCode(10);

interface Control {
  control: string;
  source: string;
  rule: string | null;
  /** 'Dockerfile' or 'compose.yaml' - which file the fixture is written into. */
  file: 'Dockerfile' | 'compose.yaml';
  risky: string;
  safe: string;
}

const svc = (lines: string[]) => ['services:', '  app:', '    image: nginx:1.27@sha256:abc', ...lines, ''].join(NL);

const CONTROLS: Control[] = [
  {
    control: 'Create a user; do not run as root',
    source: 'Docker docs, "Building best practices" - USER',
    rule: 'runs-as-root',
    file: 'Dockerfile',
    risky: ['FROM node:24-slim@sha256:abc', 'COPY . /app', 'CMD ["node", "index.js"]'].join(NL),
    safe: ['FROM node:24-slim@sha256:abc', 'COPY . /app', 'USER node', 'CMD ["node", "index.js"]'].join(NL),
  },
  {
    control: 'Pin the base image, do not float on a tag',
    source: 'Docker docs, "Building best practices" - pin base image versions',
    rule: 'unpinned-base',
    file: 'Dockerfile',
    risky: ['FROM node:latest', 'USER node', 'CMD ["node", "index.js"]'].join(NL),
    safe: ['FROM node:24-slim@sha256:abc', 'USER node', 'CMD ["node", "index.js"]'].join(NL),
  },
  {
    control: 'Use COPY rather than ADD from a URL',
    source: 'Docker docs, "Building best practices" - ADD or COPY',
    rule: 'add-from-url',
    file: 'Dockerfile',
    risky: ['FROM alpine:3.20@sha256:abc', 'ADD https://example.com/pkg.tar.gz /tmp/', 'USER nobody'].join(NL),
    safe: ['FROM alpine:3.20@sha256:abc', 'COPY pkg.tar.gz /tmp/', 'USER nobody'].join(NL),
  },
  {
    control: 'Do not pipe a downloaded script straight into a shell',
    source: 'Docker docs on RUN, and the install-script pattern every vendor warns about',
    rule: 'pipe-to-shell',
    file: 'Dockerfile',
    risky: ['FROM alpine:3.20@sha256:abc', 'RUN curl -sSL https://example.com/install.sh | sh', 'USER nobody'].join(NL),
    safe: ['FROM alpine:3.20@sha256:abc', 'COPY install.sh .', 'RUN sh ./install.sh', 'USER nobody'].join(NL),
  },
  {
    control: 'Do not run a container privileged',
    source: 'Docker docs, "Runtime privilege and Linux capabilities" - --privileged',
    rule: 'privileged',
    file: 'compose.yaml',
    risky: svc(['    privileged: true']),
    safe: svc(['    privileged: false']),
  },
  {
    control: 'Do not mount the daemon socket into a container',
    source: 'Docker docs, "Docker daemon attack surface" - mounting /var/run/docker.sock',
    rule: 'docker-socket',
    file: 'compose.yaml',
    risky: svc(['    volumes:', '      - /var/run/docker.sock:/var/run/docker.sock']),
    safe: svc(['    volumes:', '      - ./data:/data']),
  },
  {
    control: 'Do not share the host network namespace',
    source: 'Docker docs, "Network drivers" - host networking removes isolation',
    rule: 'host-network',
    file: 'compose.yaml',
    risky: svc(['    network_mode: host']),
    safe: svc(['    networks:', '      - internal']),
  },
  {
    control: 'Do not add capabilities that undo the sandbox',
    source: 'Docker docs, "Runtime privilege and Linux capabilities" - cap_add',
    rule: 'dangerous-capability',
    file: 'compose.yaml',
    // The inline form, which is how Compose's own reference writes a short list.
    risky: svc(['    cap_add: ["SYS_ADMIN"]']),
    // Dropping a capability is the hardening, and must never be read as granting one.
    safe: svc(['    cap_drop:', '      - SYS_ADMIN']),
  },
];

export interface Measured {
  control: string;
  source: string;
  noticed: boolean;
  accused: boolean;
}

function fired(file: Control['file'], body: string, rule: string | null): boolean {
  if (rule === null) return false;
  const root = mkdtempSync(join(tmpdir(), 'tewip-container-recall-'));
  try {
    mkdirSync(join(root, 'deploy'), { recursive: true });
    writeFileSync(join(root, 'deploy', file), body, 'utf8');
    return scanIac(root).findings.some((f) => f.rule === rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function measure(): Measured[] {
  return CONTROLS.map((c) => ({
    control: c.control,
    source: c.source,
    noticed: fired(c.file, c.risky, c.rule),
    accused: fired(c.file, c.safe, c.rule),
  }));
}

function report(): void {
  const all = measure();
  const noticed = all.filter((m) => m.noticed);
  const accused = all.filter((m) => m.accused);
  const pct = (n: number) => `${((n / all.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      "# infra's Dockerfile and Compose rules, measured against Docker's own documentation",
      '',
      `${all.length} controls, each planted twice: once in the shape Docker warns against, once in the shape it recommends.`,
      '',
      `Controls noticed:            ${noticed.length} of ${all.length} (${pct(noticed.length)})`,
      `Recommended shapes accused:  ${accused.length} of ${all.length}`,
      '',
      '## Controls it does not see',
      '',
      ...(all.filter((m) => !m.noticed).length === 0 ? ['None.'] : all.filter((m) => !m.noticed).map((m) => `- **${m.control}** — ${m.source}`)),
      '',
      '## Recommended configuration it reported anyway',
      '',
      ...(accused.length === 0 ? ['None.'] : accused.map((m) => `- **${m.control}** — ${m.source}`)),
      '',
      '---',
      '',
      "Ground truth: Docker's own documentation, named rather than numbered, because CIS Docker",
      'numbering drifts the way CIS Kubernetes and CIS AWS do. What this cannot settle is whether a',
      'base image is itself sound, which needs the built image rather than the file that names it.',
      '',
    ].join(NL),
  );
}

if (import.meta.main) report();
