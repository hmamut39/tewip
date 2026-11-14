// What the triage engine actually finds, per category, across every pinned dataset at once.
//
// Every check in this product publishes a measured recall against a list somebody else wrote, and
// `engine/test/confidence-is-current.test.ts` re-derives each of them in CI. The triage engine -
// the oldest part, the thing `explain`, `done` and the MCP tools are built on - publishes one
// number: overall accuracy. Every triage report ends with "Measured accuracy on real CI data: see
// eval/README.md", which is a pointer rather than a figure, and the figure it points at is the
// overall one.
//
// That number is true and it is carried by one category. On the 9 November shadow run, 8,786 of
// gutenberg's 9,497 labelled cases were TIMING, so 96.4% overall was mostly "it recognises a flaky
// timeout". The question a developer opens this tool to ask - is this a real bug - is answered
// correctly about one time in six.
//
// The shape of the misses is the part worth publishing. The engine does not get REAL_BUG wrong; it
// *refuses* it: 97 of 102 misses across these datasets came back UNKNOWN, which routes the failure
// to a person with the evidence attached. llm-diagnose.ts explains why, from a 471-case measurement
// in Phase 56: REAL_BUG sits at its 3-6% base rate in every bucket of the evidence a classifier can
// see when a test fails, so nothing visible at failure time separates a real bug from flakiness.
//
// "We identify one real bug in six and refuse the rest rather than guess" is a defensible sentence.
// "96.4% accurate" is not, once somebody checks.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { readJsonl } from '../reporters/store.ts';
import { ROOT_CAUSES, type RootCause } from '../reporters/types.ts';
import { matchLabels, type GroundTruthLabel } from './evaluate.ts';

const NL = String.fromCharCode(10);

/** Each pinned dataset and the labels that go with it, by the names they have on disk. */
const PINNED: Array<{ labels: string; data: string }> = [
  { labels: 'eval/ground-truth.jsonl', data: 'data/real/gutenberg' },
  { labels: 'eval/ground-truth.fresh.jsonl', data: 'data/real/gutenberg-fresh' },
  { labels: 'eval/ground-truth.holdout.jsonl', data: 'data/real/gutenberg-holdout' },
  { labels: 'eval/ground-truth.gutenberg-local.jsonl', data: 'data/real/gutenberg-local' },
  { labels: 'eval/ground-truth.aug2.jsonl', data: 'data/real/gutenberg-aug2' },
  { labels: 'eval/ground-truth.supabase.jsonl', data: 'data/real/supabase' },
  { labels: 'eval/ground-truth.jupyterlab.jsonl', data: 'data/real/jupyterlab' },
];

export interface CategoryScore {
  category: RootCause;
  found: number;
  of: number;
  /** Misses the engine refused outright, which route to a person rather than mislead. */
  refused: number;
  /** Misses it put in another category, which are the ones that actually mislead. */
  misread: number;
}

export interface TriageRecall {
  categories: CategoryScore[];
  /** Datasets that were on disk and could be read. */
  datasets: string[];
  /** Named rather than skipped, so a thin measurement cannot look like a complete one. */
  missing: string[];
}

export async function measure(root = process.cwd()): Promise<TriageRecall> {
  const tally = new Map<RootCause, CategoryScore>(
    ROOT_CAUSES.map((c) => [c, { category: c, found: 0, of: 0, refused: 0, misread: 0 }]),
  );
  const datasets: string[] = [];
  const missing: string[] = [];

  for (const pin of PINNED) {
    const labelsAt = join(root, pin.labels);
    const dataAt = join(root, pin.data);
    if (!existsSync(labelsAt) || !existsSync(dataAt)) {
      missing.push(pin.data);
      continue;
    }
    const labels = readJsonl<GroundTruthLabel>(labelsAt);
    const dataset = loadDataset(dataAt);
    const index = new HistoryIndex(dataset.records, dataset.summaries);
    const matched = matchLabels(dataset.records, labels);
    if (matched.length === 0) {
      missing.push(pin.data);
      continue;
    }
    // Rules only, deliberately. The model layer is capped below the escalation threshold, so every
    // verdict it produces routes to a person anyway; measuring with it on would score a label the
    // product never acts on, and would cost a model call per case to do it.
    const diagnoses = await diagnosePipeline(
      matched.map((m) => m.record),
      index,
      null,
    );
    datasets.push(pin.data);
    for (const [i, m] of matched.entries()) {
      const score = tally.get(m.label.label as RootCause);
      if (!score) continue;
      score.of += 1;
      const got = diagnoses[i].category;
      if (got === m.label.label) score.found += 1;
      else if (got === 'UNKNOWN') score.refused += 1;
      else score.misread += 1;
    }
  }
  return { categories: [...tally.values()].filter((c) => c.of > 0), datasets, missing };
}

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

function report(r: TriageRecall): void {
  const total = r.categories.reduce((a, c) => a + c.of, 0);
  const found = r.categories.reduce((a, c) => a + c.found, 0);
  const lines = [
    '# the triage engine, per category, across every pinned dataset',
    '',
    `${total} labelled failures from ${r.datasets.length} dataset(s), rules only.`,
    '',
    '| category | found | refused (UNKNOWN) | put in the wrong category |',
    '| --- | --- | --- | --- |',
    ...r.categories.map((c) => `| ${c.category} | ${c.found}/${c.of} = ${pct(c.found, c.of)} | ${c.refused} | ${c.misread} |`),
    '',
    `Overall: ${found}/${total} = ${pct(found, total)}.`,
    '',
    '## What the shape of the misses says',
    '',
    `${r.categories.reduce((a, c) => a + c.refused, 0)} of the misses were refusals and ` +
      `${r.categories.reduce((a, c) => a + c.misread, 0)} were put in another category. The engine does not`,
    'often get a failure wrong; where it cannot tell, it says so, and the failure goes to a person',
    'with its evidence attached. That is the behaviour the 0.45 ceiling and the 0.5 escalation',
    'threshold exist to produce, and it is why the overall figure and the per-category figures say',
    'such different things.',
    '',
    ...(r.missing.length > 0
      ? ['**Datasets not read**, so this is a floor rather than the whole picture:', '', ...r.missing.map((m) => `- ${m}`), '']
      : []),
    '---',
    '',
    'What this rests on: labels established from CI evidence - a failure that passed on retry, one',
    'that recurs on unrelated branches, one fixed by a change to the application. What it cannot',
    'settle is a real bug that nothing in the failure distinguishes from flakiness, which Phase 56',
    'measured at its base rate in every bucket and which is the whole reason REAL_BUG reads as it',
    'does here.',
    '',
  ];
  process.stdout.write(lines.join(NL));
}

// `import.meta.main`, not a substring of argv[1]: a test file named after this harness
// made `process.argv[1].includes('triage-recall')` true, so importing it to read its exports ran the
// whole measurement - minutes of work, on a module that was only being imported.
if (import.meta.main) report(await measure());
