// What the triage engine finds, per category, recorded rather than asserted.
//
// Every check in this product publishes a measured recall and has it re-derived in CI. The triage
// engine - the oldest part, and the one `explain`, `done` and the MCP tools are built on - published
// a single overall figure, and the reports pointed at a file rather than naming it: "Measured
// accuracy on real CI data: see eval/README.md".
//
// Overall accuracy is true and it is carried by one category. Of the 2,358 labelled failures here,
// 1,682 are TIMING, so an engine that recognised nothing but a flaky timeout would score near 70%
// without answering a single useful question. The question a developer opens this tool to ask -
// is this a real bug - comes back right about one time in seven.
//
// Two facts, and both have to be said. The engine finds roughly one real bug in seven, which is a
// limitation somebody choosing this tool should weigh. And where it cannot tell, it refuses rather
// than misleads: 221 of its 260 misses are UNKNOWN, which routes the failure to a person with the
// evidence attached, instead of sending them after a bug that is not there. The second is why the
// first is survivable; it is not an answer to it.
//
// Re-derive the whole table with `node eval/triage-recall.ts`.
export interface CategoryRecall {
  category: string;
  found: number;
  of: number;
  /** Misses it declined outright. These route to a person rather than mislead one. */
  refused: number;
  /** Misses it put in another category. These are the ones that actually mislead. */
  misread: number;
}

/** Measured 14 November 2026 over 7 pinned datasets, rules only. */
export const TRIAGE_RECALL: CategoryRecall[] = [
  { category: 'TIMING', found: 1575, of: 1682, refused: 86, misread: 21 },
  { category: 'ENV', found: 479, of: 516, refused: 24, misread: 13 },
  { category: 'TEST_DATA', found: 6, of: 8, refused: 2, misread: 0 },
  { category: 'LOCATOR_DRIFT', found: 21, of: 33, refused: 12, misread: 0 },
  { category: 'REAL_BUG', found: 17, of: 119, refused: 97, misread: 5 },
];

export const TRIAGE_CASES = TRIAGE_RECALL.reduce((a, c) => a + c.of, 0);
export const TRIAGE_FOUND = TRIAGE_RECALL.reduce((a, c) => a + c.found, 0);
export const TRIAGE_REFUSED = TRIAGE_RECALL.reduce((a, c) => a + c.refused, 0);
export const TRIAGE_MISREAD = TRIAGE_RECALL.reduce((a, c) => a + c.misread, 0);

const share = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;

/**
 * The sentence a triage report carries about its own reliability.
 *
 * It names the categories rather than averaging them, because the average is the thing that was
 * hiding the answer. Ordered strongest first, so the weakest number is the one a reader is left
 * holding - which is the right way round for a figure somebody is going to act on.
 */
export const triageReliability = (): string =>
  `Measured on ${TRIAGE_CASES.toLocaleString('en-GB')} labelled CI failures: ` +
  TRIAGE_RECALL.map((c) => `${share(c.found, c.of)} of ${c.category}`).join(', ') +
  `. Where it cannot tell it answers UNKNOWN rather than guessing - ${share(TRIAGE_REFUSED, TRIAGE_REFUSED + TRIAGE_MISREAD)} of what it gets wrong is a refusal, ` +
  `not a wrong cause. Re-derive with \`node eval/triage-recall.ts\`.`;
