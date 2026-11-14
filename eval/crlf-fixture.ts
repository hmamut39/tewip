// The one project both halves of eval/crlf-parity.ts are run over, written twice.
//
// Split out of that file to keep it under this project’s 300-line limit, and because the
// fixture is the part most likely to be edited: every check needs something real planted for
// it, or it finds nothing, agrees with itself for free, and the measurement says nothing. Two
// checks did exactly that until the vacuity count was tightened - `approvals` had no audit log
// to read and `contracts` had no API description.

export interface Fixture {
  path: string;
  lines: string[];
}

/**
 * A project holding something for every check to find.
 *
 * Deliberately something real in each file rather than an empty project: two checks that both find
 * nothing agree perfectly and prove nothing, which is the way this harness would most easily lie.
 */
export const FIXTURE: Fixture[] = [
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
    // An API description, for `contracts`. Committed and then edited by `commitAndBreak` below, so
    // the check has a before and an after to compare rather than only a file it has never seen.
    path: 'api/openapi.yaml',
    lines: [
      'openapi: 3.0.0',
      'info:',
      '  title: Orders',
      '  version: 1.0.0',
      'paths:',
      '  /orders:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: every order',
      '  /orders/{id}:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: one order',
    ],
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

