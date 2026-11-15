// Does the paid layer earn its money?
//
// Tewip calls a model only where the deterministic rules return UNKNOWN, so the model never
// competes with the rules - it attempts the residue they refuse. That makes its accuracy easy to
// misread. The headline figure mixes the two, and for seven weeks this project published 93.4%
// without anything re-deriving it; when Phase 174 finally measured, the rules half was unchanged
// and the whole ten-point gap sat in the model layer.
//
// Phase 55 had already measured it once, on 17 October: 87 cases decided, 9 correct (10.3%), where
// guessing uniformly across five categories scores 20%. The layer was buying 9 right answers at the
// cost of 78 confident wrong ones. The response then was honesty rather than repair - cap the
// confidence below the escalation threshold so a person always sees it, and enforce in code the one
// rule the prompt could not make the model obey. That lifted it, and it is still near random.
//
// This file exists so that "near random" is a number per category rather than an impression, and so
// the decision it implies - keep the layer, restrict it to the categories where it beats chance, or
// switch it off - rests on measurement. Three things it reports:
//
//   1. a confusion matrix over the residue only: what the model said against what was true
//   2. precision per predicted category - when it says REAL_BUG, how often is that right
//   3. what the layer adds and costs: accuracy with it, without it, and dollars spent
//
// Run: node eval/model-layer.ts [--dataset gutenberg-fresh]
//
// Cached answers are free. The cache is keyed on sha256(model + the whole request), so this re-reads
// yesterday's calls rather than paying for them again; the cost line says if that was not true.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { llmUsage, resetLlmUsage } from '../engine/llm/usage.ts';
import { DATASET_ACCURACY, type DatasetAccuracy } from '../engine/measured.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { ROOT_CAUSES, type DiagnosisCategory } from '../reporters/types.ts';
import { readJsonl } from '../reporters/store.ts';
import { matchLabels, type GroundTruthLabel } from './evaluate.ts';

const NL = String.fromCharCode(10);
/** What the model is allowed to answer, plus the refusal that Phase 55 made it capable of. */
const ANSWERS = [...ROOT_CAUSES, 'UNKNOWN'] as const;

export interface Residue {
  /** What the rules refused and the model was asked. */
  asked: number;
  /** Of those, the ones the model answered with a root cause rather than refusing. */
  decided: number;
  correct: number;
  /** predicted -> truth -> count, over the residue only. */
  matrix: Map<string, Map<string, number>>;
}

export interface Layered {
  dataset: string;
  /** Cases with a hand label that this machine could match to a record. */
  total: number;
  rulesDecided: number;
  rulesCorrect: number;
  residue: Residue;
}

const empty = (): Residue => ({ asked: 0, decided: 0, correct: 0, matrix: new Map() });

function note(m: Map<string, Map<string, number>>, predicted: string, truth: string): void {
  const row = m.get(predicted) ?? new Map<string, number>();
  row.set(truth, (row.get(truth) ?? 0) + 1);
  m.set(predicted, row);
}

async function measureOne(d: DatasetAccuracy, root: string): Promise<Layered | null> {
  const labelsAt = join(root, d.labels);
  const dataAt = join(root, d.data);
  if (!existsSync(labelsAt) || !existsSync(dataAt)) return null;
  const labels = readJsonl<GroundTruthLabel>(labelsAt);
  const dataset = loadDataset(dataAt);
  const matched = matchLabels(dataset.records, labels);
  if (matched.length === 0) return null;

  const records = matched.map((m) => m.record);
  const index = new HistoryIndex(dataset.records, dataset.summaries);

  // Rules alone, then the same records with the model. The difference on the UNKNOWN subset is
  // exactly what the paid layer contributed, which is the only thing this file measures.
  const rulesOnly = await diagnosePipeline(records, index, null);
  const withModel = await diagnosePipeline(records, index, llmFromEnv());

  const out: Layered = { dataset: d.dataset, total: matched.length, rulesDecided: 0, rulesCorrect: 0, residue: empty() };
  for (const [i, m] of matched.entries()) {
    const truth = m.label.label;
    const rules = rulesOnly[i].category as DiagnosisCategory;
    if (rules !== 'UNKNOWN') {
      out.rulesDecided += 1;
      if (rules === truth) out.rulesCorrect += 1;
      continue;
    }
    const said = withModel[i].category as DiagnosisCategory;
    out.residue.asked += 1;
    note(out.residue.matrix, said, truth);
    if (said === 'UNKNOWN') continue;
    out.residue.decided += 1;
    if (said === truth) out.residue.correct += 1;
  }
  return out;
}

export async function measure(only?: string, root = process.cwd()): Promise<Layered[]> {
  const wanted = only ? DATASET_ACCURACY.filter((d) => d.dataset.includes(only) || d.data.includes(only)) : DATASET_ACCURACY;
  const out: Layered[] = [];
  for (const d of wanted) {
    const one = await measureOne(d, root);
    if (one) out.push(one);
  }
  return out;
}

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

/**
 * Chance for a layer that must pick one of five causes.
 *
 * Stated so "the model is right 18% of the time" can be read against something. It is a generous
 * baseline rather than a fair one - the true categories are not uniformly distributed, so a layer
 * that always guessed the commonest one would beat 20% - and the report says so rather than
 * implying 20% is the bar to clear.
 */
const CHANCE = 1 / ROOT_CAUSES.length;

function report(all: Layered[]): void {
  const lines: string[] = ['# what the model layer adds, on the cases the rules refuse', ''];

  if (all.length === 0) {
    lines.push(
      'No labelled dataset was found on this machine. The labelled failures are gitignored (`data/*`),',
      'so this measurement runs only where a harvest exists - which is also why the published figure',
      'went seven weeks without anything re-deriving it.',
      '',
    );
    process.stdout.write(lines.join(NL));
    return;
  }

  lines.push('| set | labelled | rules decided | rules right | residue | model answered | model right |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of all) {
    lines.push(
      `| ${r.dataset} | ${r.total} | ${r.rulesDecided} | ${r.rulesCorrect} (${pct(r.rulesCorrect, r.rulesDecided)}) | ` +
        `${r.residue.asked} | ${r.residue.decided} | ${r.residue.correct} (${pct(r.residue.correct, r.residue.decided)}) |`,
    );
  }
  lines.push('');

  const sum = (f: (r: Layered) => number) => all.reduce((a, r) => a + f(r), 0);
  const total = sum((r) => r.total);
  const rulesRight = sum((r) => r.rulesCorrect);
  const modelRight = sum((r) => r.residue.correct);
  const modelDecided = sum((r) => r.residue.decided);
  const asked = sum((r) => r.residue.asked);

  lines.push(
    '## What the layer is worth',
    '',
    `Rules alone: **${rulesRight}/${total} = ${pct(rulesRight, total)}** (an undecided case counts as wrong).`,
    `With the model: **${rulesRight + modelRight}/${total} = ${pct(rulesRight + modelRight, total)}**.`,
    `The layer was asked ${asked} case(s), answered ${modelDecided}, and was right on ${modelRight}.`,
    '',
    `So it adds **${pct(rulesRight + modelRight, total)} - ${pct(rulesRight, total)}** of accuracy and produces ` +
      `**${modelDecided - modelRight} wrong cause(s)** to get there.`,
    '',
    `Guessing one of ${ROOT_CAUSES.length} causes scores ${(CHANCE * 100).toFixed(0)}%. The layer scores ` +
      `${pct(modelRight, modelDecided)} on what it answers. That comparison is generous to the layer, not harsh: the ` +
      'true causes are not evenly spread, so always naming the commonest one would beat chance without knowing anything.',
    '',
  );

  // Precision per predicted category. This is the number that matters to a person reading a report:
  // not "how often is the model right overall" but "it just told me REAL_BUG - should I believe it".
  lines.push('## When it says X, how often is it X', '', '| it said | times | right | precision | what it was instead |', '| --- | --- | --- | --- | --- |');
  const merged = new Map<string, Map<string, number>>();
  for (const r of all) for (const [p, row] of r.residue.matrix) for (const [t, n] of row) for (let k = 0; k < n; k++) note(merged, p, t);
  for (const said of ANSWERS) {
    const row = merged.get(said);
    if (!row) continue;
    const times = [...row.values()].reduce((a, b) => a + b, 0);
    const right = row.get(said) ?? 0;
    const others = [...row.entries()]
      .filter(([t]) => t !== said)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${n}`)
      .join(', ');
    const label = said === 'UNKNOWN' ? 'UNKNOWN (refused)' : said;
    const precision = said === 'UNKNOWN' ? 'n/a - a refusal is not a claim' : pct(right, times);
    lines.push(`| ${label} | ${times} | ${said === 'UNKNOWN' ? '-' : right} | ${precision} | ${others || '-'} |`);
  }
  lines.push('');

  const used = llmUsage();
  lines.push(
    '## What it cost to measure',
    '',
    `${used.calls} call(s), ${used.cacheHits} cache hit(s), $${used.costUsd.toFixed(4)}.`,
    used.calls === 0
      ? 'Every answer came from the cache, so this run was free. The cache is keyed on the model and the whole request, so a changed prompt or a changed context would have shown up as real calls here.'
      : 'Calls were made, so the cache did not cover every case - a prompt, context or model change since the last run would do that, and the figures above are not comparable with a cached run until this is explained.',
    '',
    '---',
    '',
    'The model layer is called only where the rules return UNKNOWN, and its confidence is capped at',
    '0.45 - below the 0.5 escalation threshold - so every verdict it produces routes to a person with',
    'its reasoning attached. Nothing here is a verdict the product acts on by itself. That is why the',
    'layer is defensible today; it is not why it is worth paying for.',
    '',
  );
  process.stdout.write(lines.join(NL));
}

if (import.meta.main) {
  resetLlmUsage();
  const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const flag = process.argv.indexOf('--dataset');
  report(await measure(flag > -1 ? process.argv[flag + 1] : only));
}
