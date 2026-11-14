// Phase 158: the shadow run's verdict, which said MET over two categories near zero.
//
// The weekly shadow run harvests strangers' CI, labels it from CI evidence, and scores the agent
// against it. On 9 November it reported, for WordPress/gutenberg:
//
//   Phase 3 metric, overall accuracy: 9155/9497 = 96.4%  (target >= 80%: MET)
//   Balanced accuracy: 57.2%
//   REAL_BUG      15/61 = 24.6%
//   LOCATOR_DRIFT  1/12 = 8.3%
//
// Both halves are true, and that is the problem. 8,786 of those 9,497 cases are TIMING, so a
// classifier that recognised nothing but a flaky timeout would clear an 80% target comfortably
// while being no use at all for the two questions somebody opens this tool to ask. The verdict was
// computed from the overall figure alone; the balanced figure was printed one line below it and
// counted for nothing.
//
// A headline that reads as a pass because the easiest category is most of the data is the same
// defect as a check that falls silent and is read as a clean result.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verdictOf } from '../../eval/evaluate.ts';

describe('the shadow run verdict', () => {
  it('refuses the gutenberg run that used to pass', () => {
    // The real numbers from that run, to the case.
    const v = verdictOf(9155, 9497, [15 / 61, 1 / 12, 8507 / 8786, 632 / 638], ['REAL_BUG', 'LOCATOR_DRIFT', 'TIMING', 'ENV']);
    assert.equal(v.overallMet, true, 'the overall figure really is above the target; that was never in doubt');
    assert.equal(v.met, false, 'a run where REAL_BUG is 24.6% and LOCATOR_DRIFT 8.3% must not report MET');
    assert.deepEqual(
      v.weak.map((w) => w.name),
      ['REAL_BUG', 'LOCATOR_DRIFT'],
      'the verdict has to name the categories that failed, not average them away',
    );
  });

  it('still passes a run that is good across the board', () => {
    const v = verdictOf(950, 1000, [0.9, 0.85, 0.95, 0.88], ['REAL_BUG', 'LOCATOR_DRIFT', 'TIMING', 'ENV']);
    assert.equal(v.met, true);
    assert.deepEqual(v.weak, []);
  });

  it('refuses a run carried by one big category', () => {
    // The shape of the defect in miniature: one category is 95% of the data and perfect, the rest
    // are hopeless, and the overall figure sails past 80%.
    const v = verdictOf(9500, 10000, [0.99, 0.05, 0.05], ['TIMING', 'REAL_BUG', 'LOCATOR_DRIFT']);
    assert.equal(v.overallMet, true);
    assert.equal(v.balancedMet, false);
    assert.equal(v.met, false);
  });

  it('does not count a category with too few cases to trust', () => {
    // Categories under the minimum never reach `recalls`, so a single unlucky case cannot fail a
    // run on its own - supabase had 3 REAL_BUG cases and jupyterlab 2.
    const v = verdictOf(900, 1000, [0.9, 0.8], ['TIMING', 'ENV']);
    assert.equal(v.met, true, 'only categories with enough cases are judged');
  });

  it('calls a run that measured nothing neither met nor missed', () => {
    // penpot had no failing CI run in the window. A quiet week at somebody else's project is not
    // this agent scoring badly, and reporting it as a miss teaches a reader to ignore the word.
    const v = verdictOf(0, 0, [], []);
    assert.equal(v.nothingMeasured, true);
    assert.equal(v.met, false, 'nothing measured is not a pass either');
    assert.equal(v.balanced, null);
  });
});
