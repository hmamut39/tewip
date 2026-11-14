// Overall accuracy per labelled dataset, rules only, re-derived.
//
// The README published six figures and said accuracy "ranges from 86.1% to 99.7%". On 14 November
// 2026 not one of them reproduced, and nothing had ever checked: the labelled data is gitignored
// (`data/*`), so no CI job can run this measurement and no test did.
//
// The rules layer had not drifted at all. On the fresh set it was right on 171 of the 174 cases it
// decided - the same 171 of 174 recorded when the figure was written. The gap was entirely the
// model layer, which decided the other 39 and got 7 right where the published figure needs about
// 28. No model is pinned in this project, so the published range had a silent dependency on
// somebody else's release schedule, and nothing failed when that changed.
//
// This measures rules only. `--no-llm` is not a convenience here: a figure that includes a model is
// a figure that moves without anybody touching this repository, and the product does not act on a
// model verdict anyway - the LLM layer is capped below the escalation threshold, so every verdict it
// produces routes to a person with the evidence attached.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { DATASET_ACCURACY, type DatasetAccuracy } from '../engine/measured.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { readJsonl } from '../reporters/store.ts';
import { matchLabels, type GroundTruthLabel } from './evaluate.ts';

const NL = String.fromCharCode(10);

export interface Measured {
  dataset: string;
  /** What the record in engine/measured.ts says. */
  recorded: { right: number; of: number };
  /** What this run found, or null when the data is not on this machine. */
  found: { right: number; of: number } | null;
}

async function score(d: DatasetAccuracy, root: string): Promise<{ right: number; of: number } | null> {
  const labelsAt = join(root, d.labels);
  const dataAt = join(root, d.data);
  if (!existsSync(labelsAt) || !existsSync(dataAt)) return null;
  const labels = readJsonl<GroundTruthLabel>(labelsAt);
  const dataset = loadDataset(dataAt);
  const matched = matchLabels(dataset.records, labels);
  if (matched.length === 0) return null;
  const index = new HistoryIndex(dataset.records, dataset.summaries);
  // `null` for the model layer, deliberately. See the note at the top of this file.
  const diagnoses = await diagnosePipeline(
    matched.map((m) => m.record),
    index,
    null,
  );
  let right = 0;
  for (const [i, m] of matched.entries()) if (diagnoses[i].category === m.label.label) right += 1;
  return { right, of: matched.length };
}

export async function measure(root = process.cwd()): Promise<Measured[]> {
  const out: Measured[] = [];
  for (const d of DATASET_ACCURACY) {
    out.push({ dataset: d.dataset, recorded: { right: d.right, of: d.of }, found: await score(d, root) });
  }
  return out;
}

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

function report(all: Measured[]): void {
  const read = all.filter((m) => m.found !== null);
  const drifted = read.filter((m) => m.found!.right !== m.recorded.right || m.found!.of !== m.recorded.of);
  const absent = all.filter((m) => m.found === null);

  process.stdout.write(
    [
      '# overall accuracy per labelled dataset, rules only',
      '',
      '| dataset | recorded | this run |',
      '| --- | --- | --- |',
      ...all.map(
        (m) =>
          `| ${m.dataset} | ${m.recorded.right}/${m.recorded.of} = ${pct(m.recorded.right, m.recorded.of)} | ` +
          `${m.found ? `${m.found.right}/${m.found.of} = ${pct(m.found.right, m.found.of)}` : 'not on this machine'} |`,
      ),
      '',
      `${read.length} of ${all.length} datasets read. ${drifted.length} figure(s) have moved.`,
      '',
      ...(absent.length > 0
        ? [
            '## Not measured here',
            '',
            `${absent.map((m) => m.dataset).join(', ')} - the labelled data is gitignored (\`data/*\`), so this runs only`,
            'where a harvest exists. A clean checkout cannot reproduce any of these, which is the reason the',
            'published range stayed wrong for as long as it did, and the reason the README now says so.',
            '',
          ]
        : []),
      ...(drifted.length > 0
        ? [
            '## Figures that have moved',
            '',
            ...drifted.map(
              (m) => `- **${m.dataset}**: recorded ${m.recorded.right}/${m.recorded.of}, measured ${m.found!.right}/${m.found!.of}`,
            ),
            '',
            'A number that moves is not automatically a bug - a real fix moves numbers - but it has to be',
            're-verified and explained, never recorded blindly.',
            '',
          ]
        : []),
      '---',
      '',
      'Rules only, with the model layer off. Not a convenience: the product caps a model verdict below',
      'the escalation threshold, so every one of them routes to a person anyway, and a figure that',
      'includes a model moves when a provider replaces one. The published range did exactly that.',
      '',
    ].join(NL),
  );
  if (drifted.length > 0) process.exitCode = 1;
}

if (import.meta.main) report(await measure());
