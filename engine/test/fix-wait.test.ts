// Phase 8: replacing a fixed wait with a condition. A race passes by luck, so the whole point of
// these tests is that one passing run is never enough, and that everything else is refused loudly.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { PlannedAction } from '../decide.ts';
import type { AutofixDeps } from '../autofix/autofix.ts';
import { attemptWaitFix, waitFixDiff } from '../autofix/fix-wait.ts';
import { findFixedWaits, waitFixCandidates } from '../autofix/waits.ts';

const SPEC = 'C:/repo/tests/checkout.spec.ts';
const SOURCE = [
  "import { expect, test } from '@playwright/test';",
  '',
  "test('pays with a card', async ({ page }) => {",
  "  await page.goto('/cart');",
  '  await page.waitForTimeout(3000);',
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  "  await expect(page.getByText('Thank you')).toBeVisible();",
  '});',
].join('\n');

const record: TriageRecord = {
  schemaVersion: 1, testId: 'tests/checkout.spec.ts > pays with a card', file: 'tests/checkout.spec.ts', status: 'failed',
  errorMessage: 'Timeout 5000ms exceeded', errorStack: 'at tests/checkout.spec.ts:6:52', duration: 5000, retry: 0, attachments: [],
  runId: 'r1', gitSha: 'abc', timestamp: '2026-09-22T10:00:00Z',
};
const diagnosis = { category: 'TIMING', confidence: 0.9, source: 'rules', evidence: [], engineVersion: 'rules-9', diagnosedAt: '' } as unknown as Diagnosis;
const action = { kind: 'fix-wait', owner: 'sdet', autonomous: true, summary: '', reason: '' } as PlannedAction;

/** A file in memory, and a runner that passes or fails by a script of outcomes. */
function deps(outcomes: boolean[], source = SOURCE) {
  const files = new Map([[SPEC, source]]);
  let run = 0;
  const d: AutofixDeps = {
    allowedRoot: 'C:/repo/tests',
    readFile: (p) => files.get(p) ?? '',
    writeFile: (p, c) => void files.set(p, c),
    verify: async () => ({ passed: outcomes[Math.min(run++, outcomes.length - 1)], detail: 'run' }),
    loadSnapshot: () => null,
  };
  return { d, files, runs: () => run };
}

describe('replacing a fixed wait with a condition', () => {
  it('keeps the fix only after several passes in a row, and removes the wait', async () => {
    const { d, files, runs } = deps([true, true, true]);
    const fix = await attemptWaitFix({ record, diagnosis, action, specFile: SPEC }, d);
    assert.equal(fix.status, 'fixed');
    assert.equal(fix.applied, true);
    assert.equal(runs(), 3, 'a race needs more than one passing run');
    assert.doesNotMatch(files.get(SPEC)!, /waitForTimeout/);
    assert.match(waitFixDiff(fix, 'tests/checkout.spec.ts'), /-\s*await page\.waitForTimeout\(3000\);/);
  });

  it('refuses a test that passed once by luck, and puts the file back', async () => {
    // Passes once, then keeps failing, for every candidate: luck, not a fix.
    const { d, files } = deps([true, false, false]);
    const fix = await attemptWaitFix({ record, diagnosis, action, specFile: SPEC }, d);
    assert.equal(fix.status, 'all-candidates-failed');
    assert.equal(fix.applied, false);
    assert.equal(files.get(SPEC), SOURCE, 'the file must be exactly as it was');
  });

  it('tries the explicit wait when simply removing it does not hold', async () => {
    // First candidate (removal) fails its second run; the second candidate passes three times.
    const { d, files } = deps([true, false, true, true, true]);
    const fix = await attemptWaitFix({ record, diagnosis, action, specFile: SPEC }, d, { passes: 3 });
    assert.equal(fix.status, 'fixed');
    assert.match(fix.replacement ?? '', /await expect\(page\.getByRole\('button', \{ name: 'Pay' \}\)\)\.toBeVisible\(\);/);
    assert.match(files.get(SPEC)!, /toBeVisible/);
  });

  it('refuses when nothing is asserted after the wait, since passing would prove nothing', async () => {
    const noAssertion = SOURCE.split('\n').filter((l) => !l.includes('toBeVisible')).join('\n');
    const { d } = deps([true, true, true], noAssertion);
    assert.equal((await attemptWaitFix({ record, diagnosis, action, specFile: SPEC }, d)).status, 'no-assertion');
  });

  it('never touches a file outside the tests directory', async () => {
    const { d } = deps([true, true, true]);
    const outside = { ...d, allowedRoot: 'C:/repo/tests/e2e' };
    assert.equal((await attemptWaitFix({ record, diagnosis, action, specFile: SPEC }, outside)).status, 'outside-sandbox');
  });

  it('does nothing for a failure that is not an agent-eligible wait fix', async () => {
    const { d, runs } = deps([true, true, true]);
    const manual = { ...action, autonomous: false };
    assert.equal((await attemptWaitFix({ record, diagnosis, action: manual, specFile: SPEC }, d)).status, 'not-eligible');
    assert.equal(runs(), 0, 'nothing should have been run');
  });

  it('reads a fixed wait in any of the common shapes', () => {
    const waits = findFixedWaits(['  await page.waitForTimeout(1000);', '  cy.wait(2000);', '  Thread.sleep(500);', '  time.sleep(1.5)', '  await browser.pause(250);', '  await expect(x).toBeVisible();'].join('\n'));
    assert.deepEqual(waits.map((w) => w.ms), [1000, 2000, 500, 1500, 250]);
  });

  it('offers nothing to replace a wait that is followed by no element step', () => {
    const source = ['test("x", async () => {', '  await page.waitForTimeout(1000);', '  const total = compute();', '});'].join('\n');
    assert.deepEqual(waitFixCandidates(source, findFixedWaits(source)[0], 'other'), []);
  });
});

// Phase 118: a verifier that throws must not leave the wait deleted.
//
// Of the three fixers this is the worst one to leave a half-done change in. A removed
// `waitForTimeout` reads as a deliberate cleanup, and the test it was propping up now passes by
// luck - which is the exact failure this fixer exists to repair, reintroduced by the repair.
describe('the wait goes back when the verifier throws', () => {
  const throwing = (source = SOURCE) => {
    const files = new Map([[SPEC, source]]);
    let wroteAChange = false;
    const d: AutofixDeps = {
      allowedRoot: 'C:/repo/tests',
      readFile: (p) => files.get(p) ?? '',
      writeFile: (p, c) => {
        if (c !== source) wroteAChange = true;
        files.set(p, c);
      },
      verify: async (): Promise<{ passed: boolean; detail: string }> => {
        throw new TypeError('The "file" argument must be of type string. Received undefined');
      },
      loadSnapshot: () => null,
    };
    return { d, files, wrote: () => wroteAChange };
  };

  it('restores the file and lets the error through', async () => {
    const { d, files, wrote } = throwing();
    await assert.rejects(() => attemptWaitFix({ record, diagnosis, action, specFile: SPEC }, d), /must be of type string/);
    assert.equal(wrote(), true, 'this proves nothing unless the wait really was removed first');
    assert.equal(files.get(SPEC), SOURCE, 'the fixed wait is still there');
    assert.match(files.get(SPEC) ?? '', /await page\.waitForTimeout\(3000\);/);
  });
});
