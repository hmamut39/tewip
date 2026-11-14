// Does Tewip give the same answer about a file written on Windows as about the same file on Linux?
//
// It did not, and nothing had ever asked. Every workflow in this repository ran on ubuntu-latest
// until Phase 168 added a three-platform matrix; its first run failed on Windows, and the cause was
// not an exotic one. A CRLF file split on `\n` leaves `\r` at the end of every line, and in
// JavaScript `.` does not match `\r` - so `/^\s*cap_add\s*:(.*)$/` never matches a Windows compose
// file, the flag it sets is never set, and the `dangerous-capability` rule reports nothing at all.
//
// A rule that reports nothing is the worst way for this product to fail. The whole argument is that
// absence is not approval: a check that could not run says so. A rule that silently finds zero on
// every Windows checkout says "no dangerous capabilities here" in the only language a report has.
//
// So this measures it, per check, rather than auditing 40 call sites by eye. Each check gets a
// fixture project written twice - once with LF, once with CRLF - and the two answers are compared.
// Any check that answers differently is reading line endings as content.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHECK_RUNNERS, type CheckName } from '../engine/evidence/checks.ts';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** One file in the fixture, written as a list of lines so the ending can be chosen per run. */
interface Fixture {
  path: string;
  lines: string[];
}

/**
 * A project holding something for every check to find.
 *
 * Deliberately something real in each file rather than an empty project: two checks that both find
 * nothing agree perfectly and prove nothing, which is the way this harness would most easily lie.
 */
const FIXTURE: Fixture[] = [
  {
    path: 'package.json',
    lines: ['{', '  "name": "fixture",', '  "version": "1.0.0",', '  "dependencies": { "left-pad": "1.3.0" }', '}'],
  },
  {
    path: 'package-lock.json',
    lines: [
      '{',
      '  "name": "fixture",',
      '  "version": "1.0.0",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "node_modules/left-pad": { "version": "1.3.0", "license": "WTFPL" }',
      '  }',
      '}',
    ],
  },
  {
    path: 'Dockerfile',
    lines: ['FROM node:latest', 'ADD https://example.com/pkg.tgz /tmp/', 'RUN curl -sSL https://example.com/i.sh | sh', 'COPY . /app'],
  },
  {
    path: 'compose.yaml',
    lines: [
      'services:',
      '  app:',
      '    image: nginx:1.27',
      '    privileged: true',
      '    network_mode: host',
      '    cap_add:',
      '      - SYS_ADMIN',
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock',
    ],
  },
  {
    path: 'deploy/app.yaml',
    lines: [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  template:',
      '    spec:',
      '      hostNetwork: true',
      '      containers:',
      '        - name: app',
      '          image: nginx:1.27',
      '          securityContext:',
      '            privileged: true',
      '            runAsUser: 0',
    ],
  },
  {
    path: 'infra/main.tf',
    lines: [
      'resource "aws_security_group" "ssh" {',
      '  ingress {',
      '    from_port   = 22',
      '    to_port     = 22',
      '    protocol    = "tcp"',
      '    cidr_blocks = ["0.0.0.0/0"]',
      '  }',
      '}',
      'resource "aws_db_instance" "main" {',
      '  storage_encrypted = false',
      '}',
    ],
  },
  {
    // A credential shape and a request value reaching a shell, for `secrets`.
    path: 'src/server.js',
    lines: [
      'const AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";',
      'import { execSync } from "node:child_process";',
      'export function run(req) {',
      '  return execSync("ls " + req.query.dir);',
      '}',
    ],
  },
  {
    // An agent tool declaration, for `agent`.
    path: 'src/agent.py',
    lines: [
      'from langchain.tools import tool',
      '',
      '@tool',
      'def delete_everything(path: str) -> str:',
      '    """Delete a path for good."""',
      '    import shutil',
      '    shutil.rmtree(path)',
      '    return "gone"',
    ],
  },
  {
    // A destructive migration, for `schema`.
    path: 'migrations/0001_drop.sql',
    lines: ['ALTER TABLE orders DROP COLUMN total;', 'CREATE INDEX idx_orders_user ON orders (user_id);'],
  },
  {
    // Two hand-written files, for `accepted`. These are the ones most likely to be CRLF in real
    // life: a person writes them in whatever editor they have, and on Windows that writes CRLF.
    // Without them `accepted` returned nothing and agreed with itself for free, which the vacuity
    // half of engine/test/crlf.test.ts caught.
    path: '.tewip/security-accepted.txt',
    lines: ['# reviewed by the security team', 'a1b2c3d4 - the example key from the AWS docs', 'e5f6a7b8 - a test fixture, not a credential'],
  },
  {
    path: '.tewip/access-accepted.txt',
    lines: ['# judged already', 'image-no-alt src/page.html:3 - decorative, marked aria-hidden in the template'],
  },
  {
    // Markup with a barrier, for `access`.
    path: 'src/page.html',
    lines: ['<html>', '  <body>', '    <img src="a.png">', '    <button></button>', '  </body>', '</html>'],
  },
];

function write(root: string, eol: string): void {
  for (const f of FIXTURE) {
    const at = join(root, f.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, f.lines.join(eol) + eol, 'utf8');
  }
}

export interface Parity {
  check: CheckName;
  /** JSON of the check's answer with LF files, and with CRLF files. */
  lf: string;
  crlf: string;
  agrees: boolean;
  /** How much the check found at all. A check finding nothing agrees with itself for free. */
  found: number;
}

/** The answer a check gives about one tree, as comparable text. Paths differ per run, so they go. */
function answer(check: CheckName, root: string): { text: string; found: number } {
  const raw = CHECK_RUNNERS[check]({ root });
  const text = JSON.stringify(raw ?? null)
    // The temp directory name is different between the two runs by construction.
    .split(JSON.stringify(root).slice(1, -1))
    .join('<root>')
    .split(root.split('\\').join('/'))
    .join('<root>');
  const found = Array.isArray(raw) ? raw.length : text.length;
  return { text, found };
}

export function measure(): Parity[] {
  const lfRoot = mkdtempSync(join(tmpdir(), 'tewip-parity-lf-'));
  const crlfRoot = mkdtempSync(join(tmpdir(), 'tewip-parity-crlf-'));
  try {
    write(lfRoot, LF);
    write(crlfRoot, CR + LF);
    const out: Parity[] = [];
    for (const check of Object.keys(CHECK_RUNNERS) as CheckName[]) {
      const lf = answer(check, lfRoot);
      const crlf = answer(check, crlfRoot);
      out.push({ check, lf: lf.text, crlf: crlf.text, agrees: lf.text === crlf.text, found: lf.found });
    }
    return out;
  } finally {
    rmSync(lfRoot, { recursive: true, force: true });
    rmSync(crlfRoot, { recursive: true, force: true });
  }
}

function report(): void {
  const all = measure();
  const differ = all.filter((p) => !p.agrees);
  process.stdout.write(
    [
      '# the same file, written on Windows and on Linux',
      '',
      `${all.length} checks, each run over one fixture project written twice: once with LF endings, once with CRLF.`,
      '',
      `Checks that answer the same:      ${all.length - differ.length} of ${all.length}`,
      `Checks that answer differently:   ${differ.length}`,
      '',
      '## Checks that read a line ending as content',
      '',
      ...(differ.length === 0
        ? ['None.']
        : differ.flatMap((p) => [
            `### \`${p.check}\``,
            '',
            `- with LF:   ${p.lf.length > 300 ? `${p.lf.slice(0, 300)}…` : p.lf}`,
            `- with CRLF: ${p.crlf.length > 300 ? `${p.crlf.slice(0, 300)}…` : p.crlf}`,
            '',
          ])),
      '',
      '---',
      '',
      'Why this matters more than a test failing: a rule that reads a line ending as content does not',
      'report an error, it reports nothing. This product argues that absence is not approval - that a',
      'check which could not run says so. A rule finding zero on every Windows checkout says "nothing',
      'here" in the only language a report has, to the people most likely to be running Windows.',
      '',
    ].join(LF),
  );
  if (differ.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
