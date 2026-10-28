// Phase 114: one failure, recorded three times, is not three pieces of history.
//
// Playwright writes every retry of a failing test as its own record, so a test that failed and was
// retried twice lands in the kept history three times. Nothing downstream knew that. Asked about a
// real gutenberg error, `recall` answered "5 earlier failure(s) look like this one" - and four of
// the five were the same test, three of them the same run on the same day. One event, counted
// three times, filling the slots that other history should have had. The footer compounded it:
// "Searched 1053 diagnosed failure(s)" for a project holding 573 distinct ones.
//
// Measured on the kept histories: 480 of gutenberg's 1,053 failures (46%) are retry copies of a
// failure already counted, and 126 of supabase's 903 (14%).
//
// This is the defect this project keeps finding in itself wearing new clothes: a number that reads
// as weight of evidence and is really duplication. Both numbers were honest about where they came
// from and wrong about what they counted. Counting is a claim like any other.
import { errorShape } from '../signature.ts';
import type { Memory, Recalled } from './recall.ts';

/** One run plus one test plus one error is one failure, however many attempts it took. */
export const eventKey = (memory: Memory): string =>
  `${memory.runId}::${memory.testId}::${errorShape(memory.full ?? memory.error)}`;

/** The same problem wherever it happened: the test and the error, with the run left out. */
export const problemKey = (memory: Memory): string =>
  `${memory.testId}::${errorShape(memory.full ?? memory.error)}`;

/**
 * Retry copies folded into the single failure they record, with `attempts` keeping what was folded.
 *
 * A retry that failed the same way is not new evidence about whether this has happened before. It
 * is worth knowing - a test that failed all three attempts is not behaving like a flake - so the
 * count is kept rather than discarded. A retry that failed a *different* way has a different error
 * shape and stays its own memory, because that genuinely is a second thing to know.
 */
export function oneRowPerFailure(all: Memory[]): Memory[] {
  const byEvent = new Map<string, Memory>();
  for (const memory of all) {
    const key = eventKey(memory);
    const already = byEvent.get(key);
    if (!already) {
      byEvent.set(key, { ...memory, attempts: 1 });
      continue;
    }
    already.attempts = (already.attempts ?? 1) + 1;
    // A person's correction can be recorded against one attempt. It belongs to the failure, not to
    // the attempt, and losing it would throw away the most valuable memory there is.
    if (memory.correctedBy && !already.correctedBy) {
      already.correctedBy = memory.correctedBy;
      already.correctionReason = memory.correctionReason;
      already.category = memory.category;
      already.decidedBy = memory.decidedBy;
    }
    if (memory.when > already.when) already.when = memory.when;
  }
  return [...byEvent.values()];
}

export interface Grouped extends Recalled {
  /** Distinct runs in which this test failed this way, this one included. */
  occurrences: number;
  /** The first and last run of it, by date, when there was more than one. */
  firstSeen?: string;
  lastSeen?: string;
  /** Set only when the kept decisions disagree with each other: "3 x REAL_BUG, 1 x FLAKY". */
  disagreed?: string;
}

/** "3 x REAL_BUG, 1 x FLAKY", or nothing at all when every run was decided the same way. */
function disagreement(decisions: string[]): string | undefined {
  const tally = new Map<string, number>();
  for (const category of decisions) tally.set(category, (tally.get(category) ?? 0) + 1);
  if (tally.size < 2) return undefined;
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => `${n} x ${category}`)
    .join(', ');
}

/**
 * One row per problem rather than per run, best match first.
 *
 * Four runs of the same test failing the same way is one thing to know, said four times. Grouping
 * them is not hiding history: the run count, the span of dates and any disagreement between the
 * decisions all survive, and together they answer "has this happened before" better than four
 * near-identical bullets do. It matters most because the answer is capped - ungrouped, one
 * recurring problem took four of the five slots and the rest of the history was never shown.
 *
 * A disagreement between runs is the one thing here worth more than the match itself: if this
 * project called the same failure a real bug twice and a flake twice, the honest answer to "what
 * did we decide" is that we did not agree, and no amount of ranking should smooth that over.
 *
 * The input must already be in the order the reader should see. The first member of each group is
 * its representative, so grouping preserves that order.
 */
export function oneRowPerProblem(found: Recalled[]): Grouped[] {
  const groups = new Map<string, { row: Grouped; runs: Set<string>; decisions: string[]; dates: string[] }>();
  for (const memory of found) {
    const key = problemKey(memory);
    const already = groups.get(key);
    if (!already) {
      groups.set(key, {
        row: { ...memory, occurrences: 1 },
        runs: new Set([memory.runId]),
        decisions: [memory.category],
        dates: memory.when ? [memory.when] : [],
      });
      continue;
    }
    already.runs.add(memory.runId);
    already.decisions.push(memory.category);
    if (memory.when) already.dates.push(memory.when);
    already.row.attempts = (already.row.attempts ?? 1) + (memory.attempts ?? 1);
    if (memory.correctedBy && !already.row.correctedBy) {
      already.row.correctedBy = memory.correctedBy;
      already.row.correctionReason = memory.correctionReason;
    }
  }
  return [...groups.values()].map(({ row, runs, decisions, dates }) => {
    row.occurrences = runs.size;
    const disagreed = disagreement(decisions);
    if (disagreed) row.disagreed = disagreed;
    if (runs.size > 1 && dates.length > 0) {
      const sorted = [...dates].sort();
      row.firstSeen = sorted[0];
      row.lastSeen = sorted[sorted.length - 1];
    }
    return row;
  });
}
