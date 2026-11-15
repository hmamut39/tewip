// The one thing worth saying when no rule applies.
//
// Phase 56 measured 471 labelled failures from one project and concluded that no signal available
// at failure time moves REAL_BUG off its base rate - that the question is not answerable until the
// commit that fixes the test arrives, days later. That conclusion has been load-bearing ever since:
// it is why the model layer is capped, why a REAL_BUG resting on a timeout is refused, and why the
// roadmap called the remaining gap evidential rather than algorithmic.
//
// Phase 179 asked the same question of all eight labelled projects - 1,961 failures - and it does
// not hold. Pooled, an assertion error carries REAL_BUG at 12% against a 2% base rate when it is
// absent, with 95% intervals of 10-15% and 1-2%: nowhere near overlapping, and replicated across
// four independent harvests.
//
// The effect is far larger where it matters. The rules decide 91% of failures already; what reaches
// here is the residue they refuse, and inside that residue REAL_BUG runs at **49%**, not 5%. An
// assertion error naming no element is the sharpest cut found in it.
//
// The first draft of this rule was that cut and nothing else, and it was wrong. It scored 100% on
// the four harvests it had been chosen from and then fired 19 times on `gutenberg-local` - the one
// corpus it had never been selected on - and was right 4 times. Fifteen of those misses were a
// single flaky test failing over and over. At the level of distinct tests that reads 4 of 5, which
// looks survivable; at the level of reports a person opens it is fifteen wrong causes out of one
// test, and sending a team after a bug that is not there is the most expensive mistake this tool
// makes. An in-sample figure of 96% is exactly the kind of number this project has twice had to
// withdraw, and only the held-out corpus found it.
//
// What fixed it was the history discipline the narrower `real-bug-assertion` rule already applied,
// below: a test with no history is not stable, and one that passes and fails on and off is flaky
// whatever its error text says. With that guard the rule fires 27 times across every labelled
// corpus here and is right 27 - including on the held-out one - across 22 distinct tests, and adds
// no wrong cause anywhere. REAL_BUG recall goes from 17 of 119 to 44 of 119 with the number of
// misread failures unchanged at 39.
//
// Two limits, stated here rather than discovered later:
//
//   - It fires only where every other rule declined. That is exactly the population it was measured
//     on, and running it anywhere else would be a different rule with no number behind it.
//   - One held-out corpus is one, and on it this rule fired exactly once. Phase 182 put a number
//     on how thin that is: on the same corpus the pattern *without* the history guard - assertion,
//     no element named - is a real bug 3 times in 18. The guard threw away seventeen of those and
//     kept the one that was, which is the guard working, and it is also a single observation. The
//     next harvest nobody has seen is the test that still matters.
//   - Phase 182 also tried to turn these signals into an ordering of the failures the rules refuse,
//     so a person could be told which to open first. It ranks them 92% / 44% / 25% on the corpora
//     the signals came from and 17% / 21% on the one they did not, which is backwards. There is no
//     ranking in the product for that reason: `node eval/real-bug-signal.ts --rank`.
import { isAssertion, mentionsLocator } from './evidence/failure-signals.ts';
import type { Evidence } from '../reporters/types.ts';

/**
 * 0.70, which is what the measurement supports and no more.
 *
 * Above the 0.5 that routes a failure to a person as a decided answer, and deliberately below the
 * 0.85 that `tewip fix --code` and the merge gate require: a rule selected after the fact on 25
 * observations may tell somebody where to look, and may not authorise a machine to change code. If
 * a later harvest replicates it, that is the moment to raise this, not before.
 */
export const LAST_RESORT_CONFIDENCE = 0.7;

/** Measured 15 November 2026 across every labelled corpus, after the history guard below. */
export const LAST_RESORT_MEASURED = { right: 27, of: 27, tests: 22, heldOutRight: 1, heldOutOf: 1 };

/** The slice of a test's history this rule needs; the same fields `real-bug-assertion` reads. */
export interface LastResortHistory {
  runs: number;
  failingStreak: number;
  failuresBeforeStreak: number;
  streakDistinctErrors: number;
}

export interface LastResort {
  category: 'REAL_BUG';
  confidence: number;
  evidence: Evidence[];
}

/**
 * A bug when the test says a value was wrong and never mentions an element.
 *
 * The locator clause is doing real work rather than tidying: inside the residue, a failure that
 * names a locator is REAL_BUG 36% of the time and one that does not is 76%. An error that talks
 * about an element is usually talking about finding it, which is drift or a race; an assertion that
 * talks only about values has already found what it was looking for and disagrees with what it
 * holds.
 */
export function lastResortDiagnosis(errorMessage: string | undefined | null, history: LastResortHistory): LastResort | null {
  const error = errorMessage ?? '';
  if (!isAssertion(error) || mentionsLocator(error)) return null;
  // The guard the first draft of this rule did not have, and the reason it was measured again.
  //
  // Without it the rule fired 19 times on the one corpus it had not been selected on and was right
  // 4 - and the 15 misses were a single flaky test failing over and over. At the level of distinct
  // tests that read as 4 of 5, which looks survivable; at the level of reports a person actually
  // opens it is 15 wrong causes from one test, and sending a team after a bug that is not there is
  // the most expensive mistake this tool makes.
  //
  // So the same history discipline the narrower `real-bug-assertion` rule already applies: a test
  // with no history cannot be called stable, and one that has passed and failed on and off is
  // flaky by definition, whatever its error text says.
  if (history.runs < 2) return null;
  if (history.failingStreak === 0 || history.failuresBeforeStreak > 0) return null;
  if (history.streakDistinctErrors > 1) return null;
  return {
    category: 'REAL_BUG',
    confidence: LAST_RESORT_CONFIDENCE,
    evidence: [
      {
        source: 'last-resort-assertion',
        message:
          `no rule applies, and the failure is an assertion about a value that names no element. ` +
          `Its history is a clean failing streak, so it is not flaky. Across the failures the rules ` +
          `refuse, that pattern was a real bug ${LAST_RESORT_MEASURED.right} of ` +
          `${LAST_RESORT_MEASURED.of} times, over ${LAST_RESORT_MEASURED.tests} distinct tests. ` +
          `Re-derive with \`node eval/real-bug-signal.ts --residue\`.`,
      },
    ],
  };
}
