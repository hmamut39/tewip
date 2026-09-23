// Decisions a change alters outside the tests. What these tests protect is not cleverness but
// quiet: measured against 30 ordinary merged pull requests, this speaks up on about a quarter of
// them, and every false item it showed there came from treating markup as code.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedAgreements, renderAgreements } from '../review/agreements.ts';

const NL = String.fromCharCode(10);
const change = (file: string, minus: string, plus = ''): string =>
  [`diff --git a/${file} b/${file}`, '@@ -1,1 +1,1 @@', `-${minus}`, ...(plus ? [`+${plus}`] : [])].join(NL);

describe('decisions a change alters', () => {
  it('reports a value other code falls back on', () => {
    const [found] = changedAgreements('.', 'r', change('src/limits.ts', 'const MAX_RETRIES = 3;', 'const MAX_RETRIES = 30;'));
    assert.equal(found.kind, 'limit', 'a retry count is a limit before it is a default');
    assert.match(found.before, /= 3;/);
    assert.match(found.after, /= 30;/);
  });

  it('reports a guard that was removed outright', () => {
    const [found] = changedAgreements('.', 'r', change('src/pay.ts', '  if (!user.verified) throw new Error("unverified");'));
    assert.equal(found.kind, 'guard');
    assert.match(found.why, /used to reject is now accepted/);
  });

  it('reports what a job runs on, which carries no version number', () => {
    // A real pull request bumped this by accident and was reverted for it.
    const [found] = changedAgreements('.', 'r', change('.github/workflows/ci.yml', '    runs-on: macos-14', '    runs-on: macos-26'));
    assert.equal(found.kind, 'pin');
    assert.match(found.why, /what this runs on changed/);
  });

  it('says nothing about markup, where these words mean something else', () => {
    // `min-w-0` becoming `min-w-[9rem]` is not a limit on anything.
    assert.deepEqual(changedAgreements('.', 'r', change('src/Row.tsx', '  <div className="min-w-0 flex-1">', '  <div className="min-w-[9rem] flex-1">')), []);
    assert.deepEqual(changedAgreements('.', 'r', change('src/app.css', '  max-width: 60%;', '  max-width: 80%;')), []);
  });

  it('says nothing about a line that was added, or a new file', () => {
    assert.deepEqual(changedAgreements('.', 'r', [`diff --git a/src/a.ts b/src/a.ts`, '@@ -0,0 +1,1 @@', '+const TIMEOUT_MS = 5000;'].join(NL)), []);
    assert.deepEqual(changedAgreements('.', 'r', [`diff --git a/src/b.ts b/src/b.ts`, 'new file mode 100644', '@@ -0,0 +1,1 @@', '+const TIMEOUT_MS = 5000;'].join(NL)), []);
  });

  it('says nothing about tests, which the other check reads', () => {
    assert.deepEqual(changedAgreements('.', 'r', change('src/a.test.ts', 'const TIMEOUT_MS = 5000;', 'const TIMEOUT_MS = 50;')), []);
  });

  it('ignores a rewrite that is not the same statement', () => {
    assert.deepEqual(changedAgreements('.', 'r', change('src/a.ts', 'const TIMEOUT_MS = 5000;', 'export function run(): void {')), []);
  });

  it('asks rather than decides', () => {
    const report = renderAgreements([{ file: 'src/a.ts', kind: 'limit', before: 'const MAX = 3;', after: 'const MAX = 30;', why: 'a limit that decides behaviour under load changed' }]).join(NL);
    assert.match(report, /may be exactly what was intended/);
    assert.match(report, /Ask the author which of these the change needed/);
    assert.doesNotMatch(report, /\b(wrong|bug|must|should not)\b/i);
  });

  it('says nothing at all when nothing agreed was altered', () => {
    assert.deepEqual(renderAgreements([]), []);
  });
});
