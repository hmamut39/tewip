// Phase 138: the recall harness printed a rate it had not earned.
//
// Running eval/vouch-recall.ts for the first time, on engine/audit/audit.ts, it said vouch named
// "2 of 4 (50.0%)". Asked for 14 mutants of the same file instead of 8, the denominator fell to
// zero: every test it had labelled as having lost its check caught something after all, and the
// two it had called misses still held a real assertion. The figure measured the mutant budget, not
// vouch.
//
// So the label - "caught a mutant before the deletion, none after" - is only evidence of
// hollowness to the degree the mutants are many, and the harness now says so: two budgets, and a
// rate only when both agree on which tests are labelled. These tests hold that gate shut.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lostTheirCheck, report, type Judged, type Pass } from '../../eval/vouch-report.ts';

const test = (name: string, caught: string[], says: Judged['says']): Judged => ({ name, full: `s ${name}`, caught: new Set(caught), says });

/** One pass: the same tests whole and after the deletion, at a stated budget. */
const pass = (budget: number, whole: Judged[], after: Judged[]): Pass => ({ budget, asWritten: whole, afterSeeding: after });

describe('which tests provably lost their check', () => {
  it('counts one that caught a mutant before and none after', () => {
    const whole = [test('a', ['l1'], 'checks')];
    const after = [test('a', [], 'cannot-fail')];
    assert.deepEqual(lostTheirCheck(whole, after, ['a']).map((j) => j.name), ['a']);
  });

  it('does not count one that still catches something', () => {
    const whole = [test('a', ['l1'], 'checks')];
    const after = [test('a', ['l1'], 'checks')];
    assert.deepEqual(lostTheirCheck(whole, after, ['a']), []);
  });

  it('does not count one that never caught anything to begin with', () => {
    // A test for another function does not fail when this one is mutated. Counting it would be the
    // original bug in this harness, which scored vouch 0 of 12 on twelve sound tests.
    const whole = [test('a', [], 'checks')];
    const after = [test('a', [], 'checks')];
    assert.deepEqual(lostTheirCheck(whole, after, ['a']), []);
  });

  it('ignores a test whose last statement was never dropped', () => {
    const whole = [test('a', ['l1'], 'checks')];
    const after = [test('a', [], 'checks')];
    assert.deepEqual(lostTheirCheck(whole, after, ['other']), []);
  });
});

describe('the rate is withheld when the budgets disagree', () => {
  const whole = [test('a', ['l1'], 'checks'), test('b', ['l1'], 'checks')];

  it('says so, and names both counts, rather than printing a percentage', () => {
    // This is the real case: at the small budget `b` looks hollow, at the large one it does not.
    const small = pass(8, whole, [test('a', [], 'cannot-fail'), test('b', [], 'checks')]);
    const large = pass(16, whole, [test('a', [], 'cannot-fail'), test('b', ['l9'], 'checks')]);
    const page = report([small, large], ['a', 'b']);
    assert.match(page, /The labels are not settled, so no rate is reported/);
    assert.match(page, /at 8 mutant\(s\): 2 test\(s\) labelled/);
    assert.match(page, /at 16 mutant\(s\): 1 test\(s\) labelled/);
    assert.doesNotMatch(page, /[0-9]+\.[0-9]%/, 'a percentage here is exactly what fooled me the first time');
    assert.match(page, /not settled/);
  });

  it('prints a rate when both budgets label the same tests', () => {
    const after = [test('a', [], 'cannot-fail'), test('b', ['l9'], 'checks')];
    const page = report([pass(8, whole, after), pass(16, whole, after)], ['a', 'b']);
    assert.doesNotMatch(page, /not settled/);
    assert.match(page, /Named at all[^\n]*1 of 1 \(100\.0%\)/);
  });

  it('reports the larger budget verdict, not the smaller one', () => {
    const small = pass(8, whole, [test('a', [], 'cannot-fail'), test('b', [], 'cannot-fail')]);
    const large = pass(16, whole, [test('a', [], 'cannot-fail'), test('b', ['l9'], 'checks')]);
    const page = report([small, large], ['a', 'b']);
    assert.match(page, /\*\*1\*\* test\(s\) provably lost their check at 16 mutant\(s\)/);
  });
});

describe('what the page always says', () => {
  it('names the budgets it judged at, so the figure cannot be quoted without them', () => {
    const whole = [test('a', ['l1'], 'checks')];
    const after = [test('a', [], 'cannot-fail')];
    const page = report([pass(8, whole, after), pass(16, whole, after)], ['a']);
    assert.match(page, /Judged at 8 and 16 mutant\(s\)\./);
  });

  it('still says the label depends on the mutants, even when they agree', () => {
    const whole = [test('a', ['l1'], 'checks')];
    const after = [test('a', [], 'cannot-fail')];
    const page = report([pass(8, whole, after), pass(16, whole, after)], ['a']);
    assert.match(page, /the label depends on them/);
    assert.match(page, /not counted at all/);
  });

  it('reports precision separately, because accusing a sound test is the worse error', () => {
    const whole = [test('a', ['l1'], 'checks'), test('b', ['l2'], 'checks')];
    const after = [test('a', [], 'cannot-fail'), test('b', ['l2'], 'cannot-fail')];
    const page = report([pass(8, whole, after), pass(16, whole, after)], ['a', 'b']);
    assert.match(page, /Tests that still caught a mutation after the deletion: 1/);
    assert.match(page, /wrongly called unable to fail: *1/);
    assert.match(page, /## Wrongly accused/);
  });
});
