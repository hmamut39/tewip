// Phase 179. The rule that fires where every other rule has declined.
//
// Phase 56 concluded from one project that no failure-time signal moves REAL_BUG off its base rate.
// Across all eight labelled projects that does not hold: inside the residue the rules refuse,
// REAL_BUG runs at 49%, and an assertion naming no element is the sharpest cut in it.
//
// These tests exist mostly to hold the history guard in place. Without it the rule scored 100% on
// the four harvests it had been chosen from and 4 of 19 on the one it had not, because a single
// flaky test fired it fifteen times. The guard is the difference between the rule and a machine for
// sending people after bugs that are not there.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAST_RESORT_CONFIDENCE, LAST_RESORT_MEASURED, LAST_RESORT_WIDENING_REFUSED, lastResortDiagnosis } from '../last-resort.ts';

/** A test that started failing and has failed the same way ever since. */
const stable = { runs: 6, failingStreak: 3, failuresBeforeStreak: 0, streakDistinctErrors: 1 };
const ASSERTION = 'expect(received).toBe(expected)\n\nExpected: "42"\nReceived: "41"';

describe('the last-resort real-bug rule', () => {
  it('names a bug when a value assertion fails on a stable test', () => {
    const out = lastResortDiagnosis(ASSERTION, stable);
    assert.ok(out, 'an assertion about a value, naming no element, on a clean failing streak');
    assert.equal(out.category, 'REAL_BUG');
    assert.equal(out.confidence, LAST_RESORT_CONFIDENCE);
    assert.match(out.evidence[0].message, /real bug 27 of 27/, 'the evidence quotes what it rests on');
    assert.match(out.evidence[0].message, /eval\/real-bug-signal\.ts/, 'and names what would overturn it');
  });

  it('stays out of the way when the error names an element', () => {
    // Inside the residue a failure mentioning a locator is REAL_BUG 36% of the time and one that
    // does not is 76%. An error talking about an element is usually talking about finding it.
    for (const error of [
      'expect(locator).toHaveText("42")',
      'expect(page.getByRole("button")).toBeVisible()',
      'Error: expect(received).toBe(expected) at selector "#total"',
    ]) {
      assert.equal(lastResortDiagnosis(error, stable), null, `should decline: ${error}`);
    }
  });

  it('declines anything that is not an assertion', () => {
    for (const error of ['TimeoutError: Timeout 30000ms exceeded', 'ECONNREFUSED 127.0.0.1:5432', '']) {
      assert.equal(lastResortDiagnosis(error, stable), null, `should decline: ${error}`);
    }
    assert.equal(lastResortDiagnosis(null, stable), null, 'and a missing error message');
    assert.equal(lastResortDiagnosis(undefined, stable), null);
  });

  // The guard, four ways. Each of these is a test the first draft would have called a real bug.
  it('refuses a test with no history to call it stable', () => {
    assert.equal(lastResortDiagnosis(ASSERTION, { ...stable, runs: 1 }), null);
  });

  it('refuses a test that has passed and failed on and off', () => {
    // failuresBeforeStreak > 0 means it was already failing intermittently before this streak.
    assert.equal(lastResortDiagnosis(ASSERTION, { ...stable, failuresBeforeStreak: 2 }), null, 'flaky history is not a real bug');
    assert.equal(lastResortDiagnosis(ASSERTION, { ...stable, failingStreak: 0 }), null, 'not currently failing in a streak');
  });

  it('refuses when the error changed across the failing runs', () => {
    assert.equal(lastResortDiagnosis(ASSERTION, { ...stable, streakDistinctErrors: 3 }), null, 'a moving error is not one stable bug');
  });

  it('claims only the confidence the measurement earned', () => {
    // 0.70 is above the 0.5 that routes a decided answer to a person and below the 0.85 that
    // `tewip fix --code` and the merge gate need. A rule chosen after the fact may say where to
    // look; it may not authorise a machine to change code.
    assert.ok(LAST_RESORT_CONFIDENCE > 0.5, 'it has to count as decided, or it changes nothing');
    assert.ok(LAST_RESORT_CONFIDENCE < 0.85, 'and must not reach the bar auto-fix and the gate require');
    assert.equal(LAST_RESORT_MEASURED.right, LAST_RESORT_MEASURED.of, 'the record says it was right every time it fired');
    assert.ok(LAST_RESORT_MEASURED.tests > 1, 'and over more than one test');
    assert.ok(LAST_RESORT_MEASURED.heldOutOf > 0, 'including a corpus it was not selected on');
  });
});

// Phase 221. The assertion clause reads like tidying beside the locator clause, and dropping it is
// the obvious way to buy recall. It was measured on the population this rule is selected on - not
// on what is left after the rule has run, which is what `diagnosePipeline` returns and which
// answers the question backwards - and it costs more than it buys.
describe('the clause somebody will try to drop', () => {
  const stableStreak = { runs: 6, failingStreak: 3, failuresBeforeStreak: 0, streakDistinctErrors: 1 };

  it('declines a failure that names no element but asserts nothing', () => {
    // Exactly the cases a wider rule would add, in the shapes they really take in the corpora:
    // a Playwright test timeout, a waitForEvent timeout, a navigation error. Nine of the twenty-two
    // such failures were not bugs.
    for (const error of [
      'Test timeout of 120000ms exceeded.',
      'TimeoutError: browserContext.waitForEvent: Timeout 10000ms exceeded while waiting for event "page"',
      'Error: page.goto: net::ERR_ABORTED',
    ]) {
      assert.equal(lastResortDiagnosis(error, stableStreak), null, `a wider rule would fire here: ${error}`);
    }
  });

  it('keeps the price of widening written down, so it stays a decision', () => {
    const w = LAST_RESORT_WIDENING_REFUSED;
    assert.equal(w.right + (w.fires - w.right), w.fires, 'the fires account for themselves');
    assert.equal(w.right - LAST_RESORT_MEASURED.right, w.wouldAddRight, '13 real bugs the shipped rule misses');
    assert.equal(w.fires - LAST_RESORT_MEASURED.of - w.wouldAddRight, w.wouldAddWrong, 'and 9 causes that are not there');
    assert.ok(w.wouldAddWrong > 0, 'a widening with no cost would have been taken');
    assert.ok(
      w.right / w.fires < LAST_RESORT_MEASURED.right / LAST_RESORT_MEASURED.of,
      'the wider rule is less right than the shipped one, which is the whole reason it was refused',
    );
    // Held out it looks perfect, which is six cases and is why this is recorded rather than acted on.
    assert.equal(w.heldOutRight, w.heldOutOf);
    assert.ok(w.heldOutOf < 20, 'and one corpus of seven fires is not enough to overturn the above');
  });
});
