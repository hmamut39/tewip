// How often `tewip fix --code` is allowed to touch anything, measured on real labelled failures.
//
// This is the one command that writes to somebody's application code, and it is the capability a
// reader remembers. `code-fix.ts` guards it with ten refusals, and the first two decide almost
// everything: the failure has to be diagnosed REAL_BUG, and the diagnosis has to carry a confidence
// of 0.85 or more, because "code is not changed on a guess".
//
// Both numbers either side of that gate are now measured, and they point the same way. REAL_BUG
// recall is 14.3% across these datasets (eval/triage-recall.ts), and the calibration table puts
// most diagnoses in the 0.70-0.80 band. So the gate that makes this safe may also make it inert,
// and nobody had ever counted. Every other dangerous path in this project has a harness -
// flaky-safety.ts, pick-safety.ts - and the one that edits source did not.
//
// What this measures is reach, not correctness: how many real failures get as far as the model
// being asked for a patch. Whether the patch is any good is decided after, by running the test,
// which `code-fix.ts` does and will not skip.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { readJsonl } from '../reporters/store.ts';
import { matchLabels, type GroundTruthLabel } from './evaluate.ts';

const NL = String.fromCharCode(10);

/** The bar code-fix.ts sets before it will change a line of application code. */
export const FIX_NEEDS = 0.85;

const PINNED: Array<[labels: string, data: string]> = [
  ['eval/ground-truth.jsonl', 'data/real/gutenberg'],
  ['eval/ground-truth.fresh.jsonl', 'data/real/gutenberg-fresh'],
  ['eval/ground-truth.holdout.jsonl', 'data/real/gutenberg-holdout'],
  ['eval/ground-truth.gutenberg-local.jsonl', 'data/real/gutenberg-local'],
  ['eval/ground-truth.aug2.jsonl', 'data/real/gutenberg-aug2'],
  ['eval/ground-truth.supabase.jsonl', 'data/real/supabase'],
  ['eval/ground-truth.jupyterlab.jsonl', 'data/real/jupyterlab'],
];

export interface Reach {
  /** Every labelled failure considered. */
  failures: number;
  /** Diagnosed REAL_BUG at all, whatever the confidence. */
  diagnosedRealBug: number;
  /** Diagnosed REAL_BUG *and* confident enough for code-fix to proceed. */
  eligible: number;
  /** Of those eligible, the ones whose label really was REAL_BUG. */
  eligibleAndRight: number;
  /** Where the REAL_BUG diagnoses sit, so the gate's position can be judged rather than argued. */
  byConfidence: Array<{ band: string; count: number }>;
  datasets: string[];
}

const BANDS: Array<[band: string, low: number]> = [
  ['0.85 and over', 0.85],
  ['0.80 to 0.85', 0.8],
  ['0.70 to 0.80', 0.7],
  ['under 0.70', 0],
];

export async function measure(root = process.cwd()): Promise<Reach> {
  const out: Reach = { failures: 0, diagnosedRealBug: 0, eligible: 0, eligibleAndRight: 0, byConfidence: [], datasets: [] };
  const bands = new Map<string, number>(BANDS.map(([b]) => [b, 0]));

  for (const [labelsAt, dataAt] of PINNED) {
    const l = join(root, labelsAt);
    const d = join(root, dataAt);
    if (!existsSync(l) || !existsSync(d)) continue;
    const labels = readJsonl<GroundTruthLabel>(l);
    const dataset = loadDataset(d);
    const index = new HistoryIndex(dataset.records, dataset.summaries);
    const matched = matchLabels(dataset.records, labels);
    if (matched.length === 0) continue;
    // Rules only: the model layer is capped at 0.45, far below this gate, so it can never open it.
    const diagnoses = await diagnosePipeline(
      matched.map((m) => m.record),
      index,
      null,
    );
    out.datasets.push(dataAt);
    for (const [i, m] of matched.entries()) {
      out.failures += 1;
      const d2 = diagnoses[i];
      if (d2.category !== 'REAL_BUG') continue;
      out.diagnosedRealBug += 1;
      const band = BANDS.find(([, low]) => d2.confidence >= low)![0];
      bands.set(band, (bands.get(band) ?? 0) + 1);
      if (d2.confidence >= FIX_NEEDS) {
        out.eligible += 1;
        if (m.label.label === 'REAL_BUG') out.eligibleAndRight += 1;
      }
    }
  }
  out.byConfidence = BANDS.map(([band]) => ({ band, count: bands.get(band) ?? 0 }));
  return out;
}

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(2)}%`);

function report(r: Reach): void {
  process.stdout.write(
    [
      '# how far `tewip fix --code` can reach, on real labelled failures',
      '',
      `${r.failures} labelled failures from ${r.datasets.length} dataset(s), rules only.`,
      '',
      `Diagnosed REAL_BUG:                 ${r.diagnosedRealBug} (${pct(r.diagnosedRealBug, r.failures)})`,
      `Confident enough to change code:    ${r.eligible} (${pct(r.eligible, r.failures)} of all failures)`,
      `  and the label really was REAL_BUG: ${r.eligibleAndRight} of ${r.eligible}`,
      '',
      '## Where the REAL_BUG diagnoses sit',
      '',
      '| confidence | diagnoses |',
      '| --- | --- |',
      ...r.byConfidence.map((b) => `| ${b.band} | ${b.count}${b.band === '0.85 and over' ? '  <- the gate' : ''} |`),
      '',
      '---',
      '',
      'What this measures is reach: how many real failures get as far as the model being asked for a',
      'patch. Whether the patch is any good is settled afterwards by running the test, which',
      'code-fix.ts does and will not skip - it keeps a change only when the failing test passes and',
      'nothing else breaks.',
      '',
      'The gate is 0.85 because code is not changed on a guess. If the number above is small, that is',
      'the gate working, and the honest answer is to say so where the capability is advertised rather',
      'than to lower the bar.',
      '',
    ].join(NL),
  );
}

// `import.meta.main`, not a substring of argv[1]: a test file named after this harness
// made `process.argv[1].includes('autofix-reach')` true, so importing it to read its exports ran the
// whole measurement - minutes of work, on a module that was only being imported.
if (import.meta.main) report(await measure());
