// Measures the diagnosis pipeline (rules, then LLM for UNKNOWN) against hand-labelled
// ground truth and prints the phase-3 metric: overall classification accuracy.
// Usage: node eval/evaluate.ts <labels.jsonl> [--no-llm] [--verbose]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lastFailedAttempts, loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { usageLine } from '../engine/llm/usage.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { readJsonl } from '../reporters/store.ts';
import { ROOT_CAUSES, type Diagnosis, type RootCause, type TriageRecord } from '../reporters/types.ts';
import { renderTable } from '../scripts/table.ts';

const ACCURACY_TARGET = 0.8;
const REALITY_GATE_SIZE = 100;

export interface GroundTruthLabel {
  testId: string;
  /** Omit to label every collected failure of the test (only sound for deterministic synthetic tests). */
  runId?: string;
  retry?: number;
  label: RootCause;
  dataset: 'synthetic' | 'real';
  labeledBy: string;
  note?: string;
  /** How the label was established (e.g. passed-on-retry, fixed-by-app-change). */
  basis?: string;
}

/** Categories with fewer labelled cases than this are reported but not trusted. */
const MIN_CASES_PER_CATEGORY = 5;

interface Case {
  record: TriageRecord;
  label: GroundTruthLabel;
  diagnosis: Diagnosis;
  run: number;
}

const percent = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const correct = (c: Case) => c.diagnosis.category === c.label.label;

function matchLabels(records: TriageRecord[], labels: GroundTruthLabel[]): Array<{ record: TriageRecord; label: GroundTruthLabel }> {
  const unused = labels.filter((l) => !records.some((r) => r.testId === l.testId && (!l.runId || r.runId === l.runId)));
  for (const l of unused) console.warn(`[eval] label matches no collected failure: ${l.testId}${l.runId ? ` @ ${l.runId}` : ''}`);
  const out: Array<{ record: TriageRecord; label: GroundTruthLabel }> = [];
  for (const record of lastFailedAttempts(records)) {
    const candidates = labels.filter(
      (l) => l.testId === record.testId && (!l.runId || l.runId === record.runId) && (l.retry === undefined || l.retry === record.retry),
    );
    // The most specific label wins: one pinned to this run beats a test-wide one.
    const label = candidates.find((l) => l.runId) ?? candidates[0];
    if (label) out.push({ record, label });
  }
  return out;
}

function validateLabels(labels: GroundTruthLabel[], file: string): void {
  labels.forEach((l, i) => {
    if (!l.testId || !ROOT_CAUSES.includes(l.label) || !['synthetic', 'real'].includes(l.dataset)) {
      throw new Error(`${file} line ${i + 1}: needs testId, a label from ${ROOT_CAUSES.join('/')}, and dataset synthetic|real`);
    }
  });
}

function datasetLine(labels: GroundTruthLabel[]): string {
  const real = labels.filter((l) => l.dataset === 'real').length;
  if (real === 0) return 'SYNTHETIC: every label is for the pipeline-debug specs in tests/. NOT a product metric.';
  if (real === labels.length) return `REAL: ${real} labelled CI failures.`;
  return `MIXED: ${real} real and ${labels.length - real} synthetic labels. Only a real-only run counts as a product metric.`;
}

function printReport(cases: Case[], labels: GroundTruthLabel[], file: string, model: string | null, verbose: boolean): void {
  console.log(
    renderTable(
      ['Run', 'Test ID', 'Label', 'Predicted', 'Layer', 'Conf', 'OK'],
      cases.map((c) => [
        `#${c.run}`,
        c.record.testId,
        c.label.label,
        c.diagnosis.category,
        c.diagnosis.category === 'UNKNOWN' ? '-' : c.diagnosis.source,
        c.diagnosis.category === 'UNKNOWN' ? '-' : c.diagnosis.confidence.toFixed(2),
        correct(c) ? 'yes' : 'NO',
      ]),
      new Set([5]),
    ),
  );

  if (verbose) {
    for (const c of cases.filter((x) => x.diagnosis.source === 'llm' || !correct(x))) {
      console.log(`\n#${c.run} ${c.record.testId}: label ${c.label.label}, predicted ${c.diagnosis.category}`);
      for (const e of c.diagnosis.evidence.filter((x) => x.source === 'llm')) console.log(`   [llm] ${e.message}`);
    }
  }

  const byRules = cases.filter((c) => c.diagnosis.source === 'rules' && c.diagnosis.category !== 'UNKNOWN');
  const byLlm = cases.filter((c) => c.diagnosis.source === 'llm');
  const unknown = cases.filter((c) => c.diagnosis.category === 'UNKNOWN');
  const right = cases.filter(correct).length;

  console.log('\nPer category (recall = labelled cases classified correctly):');
  const recalls: number[] = [];
  for (const cat of ROOT_CAUSES) {
    const withLabel = cases.filter((c) => c.label.label === cat);
    if (withLabel.length === 0) {
      console.log(`  ${cat.padEnd(13)} no labelled cases: NOT MEASURED`);
      continue;
    }
    const got = withLabel.filter(correct).length;
    if (withLabel.length >= MIN_CASES_PER_CATEGORY) recalls.push(got / withLabel.length);
    const wrong = withLabel.filter((c) => !correct(c)).map((c) => c.diagnosis.category);
    const confusions = [...new Set(wrong)].map((w) => `${w} x${wrong.filter((x) => x === w).length}`).join(', ');
    const tooFew = withLabel.length < MIN_CASES_PER_CATEGORY ? `   (only ${withLabel.length} case(s): too few to trust)` : '';
    console.log(`  ${cat.padEnd(13)} ${got}/${withLabel.length} = ${percent(got, withLabel.length)}${confusions ? `   (wrong: ${confusions})` : ''}${tooFew}`);
  }

  const bases = [...new Set(cases.map((c) => c.label.basis).filter(Boolean))] as string[];
  if (bases.length > 0) {
    console.log('\nBy how the label was established:');
    for (const b of bases) {
      const xs = cases.filter((c) => c.label.basis === b);
      console.log(`  ${b.padEnd(30)} ${xs.filter(correct).length}/${xs.length} = ${percent(xs.filter(correct).length, xs.length)}`);
    }
  }

  for (const line of calibration(cases)) console.log(line);

  const realCount = labels.filter((l) => l.dataset === 'real').length;
  const claudeLabelled = labels.some((l) => /claude/i.test(l.labeledBy));
  console.log(`\nLabels: ${file}, ${labels.length} label line(s) covering ${cases.length} failure record(s).`);
  console.log(`        ${datasetLine(labels)}`);
  if (claudeLabelled) console.log('        Labels were written by Claude, not by a human reviewer: provisional.');
  console.log(`LLM layer: ${model ?? 'OFF (rules only)'}`);
  console.log(`Rules layer:  ${byRules.length} decided, ${byRules.filter(correct).length} correct (${percent(byRules.filter(correct).length, byRules.length)})`);
  console.log(`LLM layer:    ${byLlm.length} decided, ${byLlm.filter(correct).length} correct (${percent(byLlm.filter(correct).length, byLlm.length)})`);
  console.log(`Still UNKNOWN: ${unknown.length} (counted as wrong)`);
  console.log(usageLine());
  // Measured on the held-out set: three runs of identical code scored 142, 143 and 144 of 166.
  // Anything smaller than that is the model's sampling, not a change worth keeping or reverting.
  console.log('Model sampling moves this score by about +-1 case per 150; treat smaller differences as noise, not as a result.');
  console.log(
    `Phase 3 metric, overall accuracy: ${right}/${cases.length} = ${percent(right, cases.length)}  ` +
      `(target >= ${ACCURACY_TARGET * 100}%: ${cases.length > 0 && right / cases.length >= ACCURACY_TARGET ? 'MET' : 'MISSED'})`,
  );
  if (recalls.length > 0) {
    const balanced = recalls.reduce((a, b) => a + b, 0) / recalls.length;
    console.log(`Balanced accuracy (mean recall over ${recalls.length} categories with >= ${MIN_CASES_PER_CATEGORY} cases): ${(balanced * 100).toFixed(1)}%`);
  }
  console.log(`Reality Check Gate: ${realCount}/${REALITY_GATE_SIZE} real labelled failures${realCount >= REALITY_GATE_SIZE ? '' : ' (gate not passed; Phase 4 stays blocked)'}.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataAt = args.indexOf('--data');
  const dataDir = dataAt >= 0 ? args[dataAt + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith('--') && i !== dataAt + 1);
  if (!file) throw new Error('usage: node eval/evaluate.ts <labels.jsonl> [--data <dataset dir>] [--no-llm] [--verbose]');
  if (!existsSync(resolve(file))) {
    console.log(`No labels file at ${file}. See eval/README.md for how to create one.`);
    return;
  }
  const labels = readJsonl<GroundTruthLabel>(resolve(file));
  validateLabels(labels, file);

  const dataset = loadDataset(dataDir);
  console.log(`Dataset: ${dataset.label} (${dataset.records.length} failure records, ${dataset.summaries.length} runs)\n`);
  const index = new HistoryIndex(dataset.records, dataset.summaries);
  const runNumber = new Map(index.runIds.map((id, i) => [id, i + 1]));
  const matched = matchLabels(dataset.records, labels);

  const llm = args.includes('--no-llm') ? null : llmFromEnv();
  if (!llm && !args.includes('--no-llm')) console.warn('[eval] LLM layer is off (no OPENAI_API_KEY): measuring rules only.');
  const diagnoses = await diagnosePipeline(
    matched.map((m) => m.record),
    index,
    llm,
  );

  const cases: Case[] = matched
    .map((m, i) => ({ ...m, diagnosis: diagnoses[i], run: runNumber.get(m.record.runId)! }))
    .sort((a, b) => a.run - b.run || a.record.testId.localeCompare(b.record.testId));
  printReport(cases, labels, file, llm?.model ?? null, args.includes('--verbose'));
}

if (import.meta.main) await main();

/**
 * Is the confidence honest? Each diagnosis carries one, and people act on it: the merge gate trusts
 * 0.7 and above from a rule, auto-fix needs 0.85. Grouping diagnoses by the confidence they claimed
 * and showing how often they were actually right says whether those lines mean anything. A tool that
 * says 0.9 and is right two thirds of the time is worse than one that says 0.6 and means it.
 */
export function calibration(cases: Case[]): string[] {
  const scored = cases.filter((c) => c.diagnosis.category !== 'UNKNOWN');
  if (scored.length === 0) return [];
  const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const lines = ['', 'Is the confidence honest? (diagnoses grouped by what they claimed)', '  claimed        cases  right   observed   gap'];
  let weighted = 0;
  for (const [i, low] of edges.slice(0, -1).entries()) {
    const high = edges[i + 1];
    const group = scored.filter((c) => c.diagnosis.confidence >= low && c.diagnosis.confidence < high);
    if (group.length === 0) continue;
    const right = group.filter(correct).length;
    const observed = right / group.length;
    const claimed = group.reduce((sum, c) => sum + c.diagnosis.confidence, 0) / group.length;
    weighted += Math.abs(observed - claimed) * group.length;
    const gap = observed - claimed;
    lines.push(
      `  ${low.toFixed(1)}-${high >= 1 ? '1.0' : high.toFixed(1)}        ${String(group.length).padStart(5)}  ${String(right).padStart(5)}   ${(observed * 100).toFixed(1).padStart(6)}%   ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%`,
    );
  }
  lines.push(`  Average gap between claimed and observed: ${((weighted / scored.length) * 100).toFixed(1)} points (0 would be perfect).`);
  return lines;
}
