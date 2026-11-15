// Is "is this a real bug" answerable at failure time, on every project or only on one?
//
// Phase 56 measured 471 labelled failures from WordPress/gutenberg and found REAL_BUG sitting at
// its base rate in every bucket: no signal available when the test fails moved it at all. That
// finding is load-bearing. It is why the model layer is capped below the escalation threshold, why
// a REAL_BUG verdict resting on a timeout is refused, and why the roadmap treats the remaining
// accuracy gap as evidential rather than algorithmic.
//
// It was measured on one project. This asks the same question of all of them, because a conclusion
// drawn from one dataset and applied to a product is exactly the shape of claim this project has
// twice had to withdraw.
//
// Two numbers per bucket, never one: the rate, and the interval around it. A signal that moves
// REAL_BUG from 12% to 57% on seven cases has not moved anything - 4 of 7 is consistent with the
// base rate - and printing 57% on its own is how that becomes next month's published figure.
//
// Run: node eval/real-bug-signal.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { SIGNALS, errorOf, wilson } from '../engine/evidence/failure-signals.ts';
import { DATASET_ACCURACY } from '../engine/measured.ts';
import { readJsonl } from '../reporters/store.ts';
import { matchLabels, type GroundTruthLabel } from './evaluate.ts';

const NL = String.fromCharCode(10);
const TARGET = 'REAL_BUG';

export interface Bucket {
  /** The signal's name, and whether this bucket is the cases where it holds. */
  signal: string;
  present: boolean;
  /** Cases in this bucket, and how many were really REAL_BUG. */
  n: number;
  k: number;
}

export interface DatasetSignals {
  dataset: string;
  cases: number;
  baseK: number;
  buckets: Bucket[];
}

async function measureOne(labels: string, data: string, name: string, root: string, residueOnly: boolean): Promise<DatasetSignals | null> {
  const labelsAt = join(root, labels);
  const dataAt = join(root, data);
  if (!existsSync(labelsAt) || !existsSync(dataAt)) return null;
  const truth = readJsonl<GroundTruthLabel>(labelsAt);
  const dataset = loadDataset(dataAt);
  let matched = matchLabels(dataset.records, truth);
  if (matched.length === 0) return null;

  // The residue is the population that matters. The rules already decide 91% of cases at 98%
  // accuracy; nothing here can improve those. What is left is what they return UNKNOWN for, and
  // that set is enriched for real bugs - the base rate inside it is nothing like the base rate
  // overall, so a signal measured across everything says little about where the gain would be.
  if (residueOnly) {
    const index = new HistoryIndex(dataset.records, dataset.summaries);
    const rules = await diagnosePipeline(
      matched.map((m) => m.record),
      index,
      null,
    );
    matched = matched.filter((_, i) => rules[i].category === 'UNKNOWN');
    if (matched.length === 0) return null;
  }

  const out: DatasetSignals = { dataset: name, cases: matched.length, baseK: 0, buckets: [] };
  for (const m of matched) if (m.label.label === TARGET) out.baseK += 1;

  for (const signal of SIGNALS) {
    const tally = { true: { n: 0, k: 0 }, false: { n: 0, k: 0 } };
    for (const m of matched) {
      const side = signal.of(errorOf(m.record as never)) ? tally.true : tally.false;
      side.n += 1;
      if (m.label.label === TARGET) side.k += 1;
    }
    for (const present of [true, false]) {
      const side = present ? tally.true : tally.false;
      if (side.n > 0) out.buckets.push({ signal: signal.name, present, n: side.n, k: side.k });
    }
  }
  return out;
}

export async function measure(root = process.cwd(), residueOnly = false): Promise<DatasetSignals[]> {
  const out: DatasetSignals[] = [];
  for (const d of DATASET_ACCURACY) {
    const one = await measureOne(d.labels, d.data, d.dataset, root, residueOnly);
    if (one) out.push(one);
  }
  return out;
}

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(0)}%`);

/**
 * Does this bucket's rate sit clear of the base rate, or merely look as if it does?
 *
 * The test is whether the interval around the bucket excludes the base rate outright. That is a
 * deliberately blunt instrument and it is the right one here: the question is not "how big is the
 * effect" but "is there one at all that a project could act on".
 */
function verdictOf(k: number, n: number, base: number): 'moves it' | 'no' | 'too few' {
  if (n < 20) return 'too few';
  const { low, high } = wilson(k, n);
  if (low > base) return 'moves it';
  if (high < base) return 'moves it';
  return 'no';
}

function report(all: DatasetSignals[], residueOnly: boolean): void {
  const lines: string[] = [
    residueOnly
      ? '# does any failure-time signal move REAL_BUG, among the cases the rules refuse?'
      : '# does any failure-time signal move REAL_BUG?',
    '',
  ];

  if (all.length === 0) {
    lines.push('No labelled dataset is on this machine. The labelled failures are gitignored and stay local.', '');
    process.stdout.write(lines.join(NL));
    return;
  }

  // Pooled first. Per-dataset below it, because pooling can hide a real effect inside one project
  // and can manufacture one that exists in none - both are worth seeing rather than choosing.
  const pooledCases = all.reduce((a, d) => a + d.cases, 0);
  const pooledK = all.reduce((a, d) => a + d.baseK, 0);
  const base = pooledK / pooledCases;
  lines.push(
    `Across ${all.length} projects and ${pooledCases} labelled failures, ${pooledK} were really REAL_BUG - a base rate of **${pct(pooledK, pooledCases)}**.`,
    'A signal is only worth anything if it moves that. Each row gives the rate and the 95% interval around it.',
    '',
    '| signal | cases | REAL_BUG | rate | 95% interval | vs base |',
    '| --- | --- | --- | --- | --- | --- |',
  );

  const pooled = new Map<string, { n: number; k: number }>();
  for (const d of all) {
    for (const b of d.buckets) {
      const key = `${b.signal}\u0000${b.present}`;
      const at = pooled.get(key) ?? { n: 0, k: 0 };
      at.n += b.n;
      at.k += b.k;
      pooled.set(key, at);
    }
  }
  for (const [key, at] of pooled) {
    const [signal, present] = key.split('\u0000');
    const { low, high } = wilson(at.k, at.n);
    const verdict = verdictOf(at.k, at.n, base);
    lines.push(
      `| ${signal} — ${present === 'true' ? 'present' : 'absent'} | ${at.n} | ${at.k} | ${pct(at.k, at.n)} | ` +
        `${(low * 100).toFixed(0)}–${(high * 100).toFixed(0)}% | ${verdict} |`,
    );
  }
  lines.push('');

  lines.push('## Per project', '', '| project | labelled | REAL_BUG | base rate | any signal that moves it |', '| --- | --- | --- | --- | --- |');
  for (const d of all) {
    const dBase = d.baseK / d.cases;
    const movers = d.buckets
      .filter((b) => verdictOf(b.k, b.n, dBase) === 'moves it')
      .map((b) => `${b.signal} ${b.present ? 'present' : 'absent'} (${b.k}/${b.n})`);
    lines.push(`| ${d.dataset} | ${d.cases} | ${d.baseK} | ${pct(d.baseK, d.cases)} | ${movers.length > 0 ? movers.join('; ') : 'none'} |`);
  }
  lines.push('');

  const anyMover = [...pooled.entries()].some(([, at]) => verdictOf(at.k, at.n, base) === 'moves it');
  lines.push(
    '## What this settles',
    '',
    anyMover
      ? 'At least one failure-time signal moves REAL_BUG clear of its base rate on the pooled data. Phase 56 concluded the opposite from one project, so that conclusion does not generalise and the rules may have a reachable gain in it.'
      : "No failure-time signal moves REAL_BUG clear of its base rate on the pooled data. Phase 56's finding holds across every project here, not only the one it was measured on: the ceiling is evidential, not algorithmic. A better model or a better prompt cannot fix it, because the information is not present when the test fails - it arrives later, in the commit that fixes it.",
    '',
    'Buckets under 20 cases are reported as `too few` rather than scored. That is not caution for its own',
    'sake: the lead that prompted this harness was a 57% rate resting on 4 cases out of 7.',
    '',
  );
  process.stdout.write(lines.join(NL));
}

if (import.meta.main) {
  const residueOnly = process.argv.includes('--residue');
  report(await measure(process.cwd(), residueOnly), residueOnly);
}
