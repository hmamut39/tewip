// Unit tests for the auto-fix loop and VERIFY -> DECIDE, with an in-memory file and a fake
// test runner. They check the safety rules, not how often real fixes succeed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import { attemptFix, type AutofixDeps } from '../autofix/autofix.ts';
import { decide, reviseAfterVerification } from '../decide.ts';
import type { SnapshotElement } from '../snapshot.ts';

const SPEC = '/sandbox/tests/shop.spec.ts';
const SOURCE = [
  "test('starts checkout', async ({ page }) => {",
  "  await page.locator('#checkout-button').click();",
  "  await expect(page.locator('#status')).toHaveText('checking out');",
  '});',
  '',
  "test('deletes the account', async ({ page }) => {",
  "  await page.getByRole('button', { name: 'Delete account' }).click();",
  '});',
].join('\n');

const record = (title: string, locator: string, line: number): TriageRecord => ({
  schemaVersion: 1,
  testId: `shop.spec.ts > ${title}`,
  file: 'tests/shop.spec.ts',
  status: 'failed',
  errorMessage: `TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for ${locator}\n`,
  errorStack: `Error\n    at ${SPEC}:${line}:5`,
  duration: 1,
  retry: 0,
  attachments: [],
  runId: 'r1',
  gitSha: '',
  timestamp: '2026-01-01T00:00:00Z',
});

const drift: Diagnosis = { category: 'LOCATOR_DRIFT', confidence: 0.95, source: 'rules', ruleId: 'locator-drift', engineVersion: 'rules-3', diagnosedAt: '', evidence: [] };
const snapshot: SnapshotElement[] = [
  { role: 'button', name: 'Checkout', text: '' },
  { role: 'button', name: 'Delete address', text: '' },
];

function deps(passes: boolean): AutofixDeps & { file: string; runs: number } {
  const state = {
    file: SOURCE,
    runs: 0,
    allowedRoot: '/sandbox/tests',
    readFile: () => state.file,
    writeFile: (_: string, content: string) => void (state.file = content),
    verify: async () => {
      state.runs++;
      return { passed: passes, detail: passes ? '1 passed' : '1 failed' };
    },
    loadSnapshot: () => snapshot,
  };
  return state;
}

describe('attemptFix', () => {
  const checkout = { record: record('starts checkout', "locator('#checkout-button')", 2), diagnosis: drift, action: decide(drift), specFile: SPEC };

  it('keeps a verified fix for an agent-eligible drift', async () => {
    const d = deps(true);
    const fix = await attemptFix(checkout, d);
    assert.equal(fix.applied, true);
    assert.match(d.file, /getByRole\('button', \{ name: 'Checkout', exact: true \}\)\.click\(\)/);
  });

  it('checks a suggestion without keeping it', async () => {
    const d = deps(true);
    const suggestion = { ...checkout, action: { ...checkout.action, autonomous: false } };
    const fix = await attemptFix(suggestion, d, { keep: false });
    assert.equal(fix.status, 'fixed');
    assert.equal(fix.applied, false);
    assert.equal(d.file, SOURCE, 'file must be restored');
  });

  it('restores the file when every candidate fails the re-run', async () => {
    const d = deps(false);
    const fix = await attemptFix(checkout, d);
    assert.equal(fix.status, 'all-candidates-failed');
    assert.equal(d.file, SOURCE);
  });

  it('refuses a test with no assertion after the failing step', async () => {
    const d = deps(true);
    const input = { record: record('deletes the account', "getByRole('button', { name: 'Delete account' })", 7), diagnosis: drift, action: decide(drift), specFile: SPEC };
    const fix = await attemptFix(input, d);
    assert.equal(fix.status, 'no-assertion');
    assert.equal(d.runs, 0);
  });

  it('never edits a file outside the sandbox', async () => {
    const d = deps(true);
    const fix = await attemptFix({ ...checkout, specFile: '/app/src/checkout.ts' }, d);
    assert.equal(fix.status, 'outside-sandbox');
    assert.equal(d.runs, 0);
  });
});

describe('reviseAfterVerification', () => {
  const suggestion = { ...decide({ ...drift, confidence: 0.8 }), autonomous: false };

  it('marks a suggestion that passed its re-run as verified', () => {
    const { action, note } = reviseAfterVerification(suggestion, { status: 'fixed', replacement: "getByRole('button', { name: 'Add to bag' })" });
    assert.equal(action.kind, 'fix-locator');
    assert.match(action.summary, /^Verified by re-running the test/);
    assert.ok(note);
  });

  it('escalates as a possible real bug when every suggested locator fails', () => {
    const { action } = reviseAfterVerification(suggestion, { status: 'all-candidates-failed' });
    assert.equal(action.kind, 'escalate');
    assert.match(action.summary, /possible real bug/);
  });
});

// Phase 118: the file goes back unless the fix is proved - including when the verifier throws.
//
// Every path out of the candidate loop restored the file except the one nobody wrote. `deps.verify`
// runs the project's own test command through `spawnSync`, and `spawnSync` throws outright rather
// than reporting a failure when it is handed no command at all - TRIAGE_VERIFY_COMMAND set to
// whitespace does exactly that. The exception then left the developer's test file holding a
// candidate Tewip never verified, in CI, on the branch ci/fix-pr.ts opens a pull request from.
//
// fix-selector.ts and code-fix.ts already restored on a throw. autofix.ts, fix-wait.ts and
// fix-data.ts predate them and did not, which is the only reason this was anywhere to be found.
describe('a verifier that throws is not a licence to keep the change', () => {
  const checkout = { record: record('starts checkout', "locator('#checkout-button')", 2), diagnosis: drift, action: decide(drift), specFile: SPEC };

  const throwing = (): AutofixDeps & { file: string } => {
    const state = {
      file: SOURCE,
      allowedRoot: '/sandbox/tests',
      readFile: () => state.file,
      writeFile: (_: string, content: string) => void (state.file = content),
      verify: async (): Promise<{ passed: boolean; detail: string }> => {
        throw new TypeError('The "file" argument must be of type string. Received undefined');
      },
      loadSnapshot: () => snapshot,
    };
    return state;
  };

  it('puts the file back and lets the error through', async () => {
    const d = throwing();
    await assert.rejects(() => attemptFix(checkout, d), /must be of type string/, 'the failure is not swallowed either');
    assert.equal(d.file, SOURCE, 'the developer keeps the file they had');
  });

  it('leaves nothing behind even when the throw comes after a write', async () => {
    // The ordering that matters: the candidate is written first, then verified. A throw in between
    // is precisely when the file is already changed.
    const d = throwing();
    let wroteACandidate = false;
    const watched: AutofixDeps = {
      ...d,
      writeFile: (file: string, content: string) => {
        if (content !== SOURCE) wroteACandidate = true;
        d.writeFile(file, content);
      },
    };
    await assert.rejects(() => attemptFix(checkout, watched));
    assert.equal(wroteACandidate, true, 'this proves nothing unless a candidate really was written');
    assert.equal(d.file, SOURCE);
  });
});
