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
// Two facts, and both have to be said. The engine finds 44 of 119 real bugs - better than one in
// three since Phase 179, and one in seven before it - which is still the limitation somebody
// choosing this tool should weigh hardest. And where it cannot tell, it refuses rather than
// misleads: 194 of its 233 misses are UNKNOWN, which routes the failure to a person with the
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
  { category: 'REAL_BUG', found: 44, of: 119, refused: 70, misread: 5 },
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

/**
 * Overall accuracy per labelled dataset, rules only.
 *
 * The README published six figures - 96.4%, 86.1%, 93.4%, 97.9%, 89.0%, 99.7% - and said accuracy
 * "ranges from 86.1% to 99.7%". Those were measured with the model layer on, and on 14 November
 * 2026 not one of them reproduced. On the fresh set, which is the one the README put in front:
 *
 *   published                93.4%
 *   with the model, today    83.6%
 *   rules only               80.3%
 *
 * The rules layer was identical to what was published - right on 171 of the 174 it decided, the
 * same 171 of 174 recorded when the figure was written. The whole gap is the model layer, which
 * decided 39 of the 213 cases and got 7 right. Reaching 93.4% needs about 28 of those 39.
 *
 * So the figures here are rules only, for three reasons, in order of weight:
 *
 *  1. The product does not act on a model verdict anyway. The LLM layer is capped below the
 *     escalation threshold, so every verdict it produces routes to a person - which means the
 *     published headline counted decisions a user never sees acted on.
 *  2. They are deterministic. No key, no cost, no network, and the same answer on every machine.
 *  3. They do not move when a provider replaces a model. No model is pinned in this project, so a
 *     figure that includes one is a figure with a silent dependency on somebody else's release
 *     schedule - which is exactly how the published range came to be wrong with nothing failing.
 *
 * Re-derive the whole table with `node eval/dataset-accuracy.ts`. It needs the labelled data,
 * which is gitignored (`data/*`), so it runs only where a harvest exists - a clean checkout cannot
 * reproduce these, and saying so is the point.
 */
export interface DatasetAccuracy {
  dataset: string;
  labels: string;
  data: string;
  right: number;
  of: number;
}

/** Measured 15 November 2026, rules only, with `--no-llm`. Phase 179 added the last-resort rule. */
export const DATASET_ACCURACY: DatasetAccuracy[] = [
  { dataset: 'gutenberg (dev)', labels: 'eval/ground-truth.jsonl', data: 'data/real/gutenberg', right: 233, of: 251 },
  { dataset: 'gutenberg (held-out)', labels: 'eval/ground-truth.holdout.jsonl', data: 'data/real/gutenberg-holdout', right: 121, of: 166 },
  { dataset: 'gutenberg (fresh)', labels: 'eval/ground-truth.fresh.jsonl', data: 'data/real/gutenberg-fresh', right: 177, of: 213 },
  { dataset: 'gutenberg (Aug 27-31)', labels: 'eval/ground-truth.aug2.jsonl', data: 'data/real/gutenberg-aug2', right: 410, of: 473 },
  { dataset: 'Supabase', labels: 'eval/ground-truth.supabase.jsonl', data: 'data/real/supabase', right: 735, of: 743 },
  { dataset: 'JupyterLab', labels: 'eval/ground-truth.jupyterlab.jsonl', data: 'data/real/jupyterlab', right: 38, of: 41 },
  { dataset: 'Penpot', labels: 'eval/ground-truth.penpot.jsonl', data: 'data/real/penpot', right: 5, of: 5 },
  { dataset: 'LXD UI', labels: 'eval/ground-truth.lxdui.jsonl', data: 'data/real/lxdui', right: 63, of: 69 },
];

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

/** The accuracy of one dataset, as the README prints it. */
export const accuracyOf = (d: DatasetAccuracy): string => pct(d.right, d.of);

/** Lowest and highest, so a range can be stated without anybody recomputing it by hand. */
export const ACCURACY_RANGE = {
  lowest: DATASET_ACCURACY.reduce((a, b) => (b.right / b.of < a.right / a.of ? b : a)),
  highest: DATASET_ACCURACY.reduce((a, b) => (b.right / b.of > a.right / a.of ? b : a)),
};

/** What the paid layer named, and how often that was the cause. Re-derive: `node eval/model-layer.ts`. */
export interface ModelPrecision {
  category: string;
  /** Times it named this cause, after every guard. */
  said: number;
  /** Times that was the hand-labelled cause. */
  right: number;
}

/**
 * Measured 15 November 2026 over 1,961 labelled failures from seven projects, cached (cost $0).
 *
 * The model is asked only what the rules refuse, so this scores the residue and nothing else. Of
 * 174 such cases it now answers 42 and refuses 132, and a refusal routes the failure to a person
 * rather than naming a cause nobody can support.
 *
 * Read `said` before `right`. The README said for a day that this layer was "right on 7 of the 39
 * cases it decides" on the fresh set; 39 is what it was *asked*. It decided 9 and was right on 7,
 * which is 78% and not 18% - the mistake understated it fourfold. Being asked is not deciding, and
 * refusing is not failing.
 */
export const MODEL_PRECISION: ModelPrecision[] = [
  { category: 'REAL_BUG', said: 5, right: 5 },
  { category: 'ENV', said: 23, right: 17 },
  { category: 'TIMING', said: 3, right: 1 },
];

/** Asked, answered and right across those seven projects, for the sentence the README prints. */
export const MODEL_LAYER = { asked: 148, answered: 31, refused: 117, right: 23, labelled: 1961 };

/** Causes the layer may no longer claim: 0 of 13 right before Phase 177 refused them. */
export const MODEL_REFUSES = ['LOCATOR_DRIFT', 'TEST_DATA'];

/**
 * The rules code that `DATASET_ACCURACY` and `TRIAGE_RECALL` were measured against.
 *
 * Both are produced where the labelled failures live, and those are deliberately not in this
 * repository, so no CI job can re-derive either. That is why a wrong headline survived seven weeks.
 * This does not fix that - only the data could - but it makes the figures *fail loudly when they
 * have gone stale*: `engine/test/fingerprint.test.ts` recomputes this hash from the source and goes
 * red when the rules have moved since the figures were last measured.
 *
 * When it goes red the figure is not necessarily wrong, it is unverified. Re-run
 * `node eval/dataset-accuracy.ts` and `node eval/triage-recall.ts` on a machine with the harvest,
 * then update the figures and this hash together. Updating the hash alone is the one thing that
 * defeats the guard, which is why the harness prints both.
 */
export const RULES_MEASURED_AT = {
  /** From `rulesFingerprint()` in engine/fingerprint.ts. */
  hash: '65eec946969bd959',
  /** How many source files the rules reach, so a collapsed closure is visible rather than silent. */
  files: 22,
  at: '2026-11-15',
  /**
   * Every harness that has to be re-run when that hash moves. All of them, named.
   *
   * Phase 180 exists because this list did not. Phase 179 changed the rules, the guard went red as
   * designed, and two of the three harnesses were re-run - so `DATASET_ACCURACY` and
   * `TRIAGE_RECALL` were right and `MODEL_LAYER` silently was not. The model is asked only what the
   * rules refuse, so a rule that decides 26 more cases changes what the model was asked, answered
   * and got right; all three figures moved and the README quoted all three.
   *
   * A guard that says "re-measure" without saying what is a guard you satisfy from memory, and
   * memory is what this whole class of defect is made of.
   */
  harnesses: ['node eval/dataset-accuracy.ts', 'node eval/triage-recall.ts', 'node eval/model-layer.ts'],
};
