// Phase 9: security. Two things are being tested, and neither is "can it find a string".
//
// First, restraint: a credential is located and never printed, a shape that is documentation is not
// a leak, and a file git does not track never left the machine. Second, the triage: a scanner's
// finding becomes "act on this now", "real but not reachable", "noise" or "a person already
// accepted it", each with the evidence that makes it checkable.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { entropyOf, looksPlanted, redact, scanSecrets } from '../secure/secrets.ts';
import { triageDependency, triageSecret, worstFirst, type SecurityItem } from '../secure/triage.ts';
import type { DepFinding } from '../secure/deps.ts';

const NL = String.fromCharCode(10);

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-sec-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

// A key that matches a published shape, made of characters no issuer ever handed out.
const FAKE_AWS = `AKIA${'Q7ZP3MXK2VLN8RTD'}`;
const FAKE_GITHUB = `ghp_${'xR7qT2mP9wK4nB6vY1cF8dH3jL5sA0zE2gQW'}`;

describe('finding a credential without printing it', () => {
  it('finds keys by the shapes their issuers publish', () => {
    const root = project({ 'src/config.ts': [`export const key = "${FAKE_AWS}";`, `export const token = "${FAKE_GITHUB}";`].join(NL) });
    const found = scanSecrets(root);
    assert.deepEqual(found.map((f) => f.kind).sort(), ['aws-access-key-id', 'github-token']);
    assert.equal(found[0].file, 'src/config.ts');
  });

  it('never prints the value, in the finding or anywhere else', () => {
    const root = project({ 'src/config.ts': `const key = "${FAKE_AWS}";` });
    const [finding] = scanSecrets(root);
    assert.ok(!finding.evidence.includes(FAKE_AWS), 'the credential itself must never appear');
    assert.match(finding.evidence, /AK\.\.\./, 'enough is shown to find the line, and no more');
    assert.match(redact('token = "abcdef123456"', 'abcdef123456'), /^token = "ab\.+"$/);
  });

  it('knows an example from a credential', () => {
    assert.match(looksPlanted('AKIAIOSFODNN7EXAMPLE', 'key = AKIAIOSFODNN7EXAMPLE', 'src/a.ts') ?? '', /example/);
    assert.match(looksPlanted('abc', 'AWS_KEY=your-key-here', 'src/a.ts') ?? '', /example/);
    assert.match(looksPlanted('abc', 'x', 'docs/setup.md') ?? '', /documentation/);
    assert.equal(looksPlanted(FAKE_AWS, `key = "${FAKE_AWS}"`, 'src/config.ts'), null);
  });

  it('measures randomness, so a stand-in is not mistaken for a key', () => {
    assert.ok(entropyOf('xxxxxxxxxxxxxxxxxxxx') < 1);
    assert.ok(entropyOf(FAKE_GITHUB) > 3);
  });

  it('reports one credential once, even when two shapes match it', () => {
    const root = project({ 'src/config.ts': 'const k = "sk-ant-api03-aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3";' });
    assert.equal(scanSecrets(root).length, 1, 'one value, one finding');
  });
});

describe('deciding what matters', () => {
  const accepted = new Set<string>();

  it('calls a committed credential a real risk, and says to revoke it first', () => {
    const root = project({ 'src/config.ts': `const key = "${FAKE_AWS}";` });
    const [finding] = scanSecrets(root);
    const item = triageSecret(finding, root, accepted);
    // The temporary folder is not a git repository, so this also proves the untracked path.
    assert.equal(item.verdict, 'not-reachable');
    assert.match(item.why, /git does not track/);
  });

  it('calls a placeholder noise rather than hiding it', () => {
    const root = project({ 'README.md': 'Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE in your environment.' });
    const found = scanSecrets(root);
    assert.equal(found.length, 1, 'it is still found');
    const item = triageSecret(found[0], root, accepted);
    assert.equal(item.verdict, 'noise');
    assert.equal(item.severity, 'low');
  });

  it('respects what a person already accepted', () => {
    const root = project({ 'src/config.ts': `const key = "${FAKE_AWS}";` });
    const [finding] = scanSecrets(root);
    const item = triageSecret(finding, root, new Set([`secret ${finding.file}:${finding.line}`]));
    assert.equal(item.verdict, 'accepted');
  });

  const vuln = (over: Partial<DepFinding> = {}): DepFinding =>
    ({ package: 'left-pad', version: '1.0.0', severity: 'high', id: 'GHSA-xxxx', title: 'left-pad is vulnerable', fixedIn: '1.3.0', source: 'npm audit', dev: false, ...over });

  it('separates a dependency this project really uses from one it merely has', () => {
    const root = project({ 'src/app.ts': "import pad from 'left-pad';" });
    const used = triageDependency(vuln(), root, [join(root, 'src/app.ts')], accepted);
    assert.equal(used.verdict, 'real-risk');
    assert.match(used.next, /upgrade left-pad to 1\.3\.0/);

    const unused = triageDependency(vuln({ package: 'lodash' }), root, [join(root, 'src/app.ts')], accepted);
    assert.equal(unused.verdict, 'not-reachable');
    assert.match(unused.why, /nothing in this project imports lodash/);
  });

  it('does not let a development dependency block a release', () => {
    const root = project({ 'src/app.ts': "import pad from 'left-pad';" });
    const item = triageDependency(vuln({ dev: true, severity: 'critical' }), root, [join(root, 'src/app.ts')], accepted);
    assert.equal(item.verdict, 'not-reachable');
    assert.match(item.next, /does not block a release/);
  });

  it('puts what needs a person first', () => {
    const items = [
      { verdict: 'noise', severity: 'low' },
      { verdict: 'real-risk', severity: 'high' },
      { verdict: 'not-reachable', severity: 'critical' },
      { verdict: 'real-risk', severity: 'critical' },
    ] as SecurityItem[];
    const sorted = [...items].sort(worstFirst).map((i) => `${i.verdict}/${i.severity}`);
    assert.deepEqual(sorted, ['real-risk/critical', 'real-risk/high', 'not-reachable/critical', 'noise/low']);
  });
});
