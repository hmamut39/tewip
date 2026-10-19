// Is the confidence honest, rule by rule?
//
// `evaluate.ts` answers that in bands - everything claiming 0.7 to 0.8, together - which is the
// right shape for "can a reader trust the number" and the wrong shape for doing anything about it.
// Two rules can share a band while one is right every time and the other is not, and the band
// average hides both.
//
// People act on this number. The merge gate lets a failure through at 0.7 from a rule, auto-fix
// needs 0.85, and the report prints it beside every diagnosis. A rule that is right 735 times out of
// 735 while claiming 0.65 is not being careful; it is sending work to a person who did not need to
// see it, and telling that person a third of these are wrong.
//
// Run: node eval/calibration.ts   (rules only, no model, no cost)
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lastFailedAttempts, loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { readJsonl } from '../reporters/store.ts';
import type { TriageRecord } from '../reporters/types.ts';

interface Label { testId: string; runId?: string; retry?: number; label: string }

/** The six datasets the published figure is measured over. */
const DATASETS: Array<[string, string]> = [
  ['eval/ground-truth.jsonl', 'data/real/gutenberg'],
  ['eval/ground-truth.holdout.jsonl', 'data/real/gutenberg-holdout'],
  ['eval/ground-truth.fresh.jsonl', 'data/real/gutenberg-fresh'],
  ['eval/ground-truth.aug.jsonl', 'data/real/gutenberg-aug'],
  ['eval/ground-truth.aug2.jsonl', 'data/real/gutenberg-aug2'],
  ['eval/ground-truth.supabase.jsonl', 'data/real/supabase'],
];

interface Tally { rule: string; claimed: number[]; cases: number; right: number; datasets: Set<string> }

const tallies = new Map<string, Tally>();
const wrong: Record<string, string[]> = {};

for (const [labelFile, dataDir] of DATASETS) {
  if (!existsSync(resolve(labelFile)) || !existsSync(resolve(dataDir))) {
    console.warn(`  skipped ${labelFile}: not present here`);
    continue;
  }
  const labels = readJsonl<Label>(resolve(labelFile));
  const dataset = loadDataset(resolve(dataDir));
  const index = new HistoryIndex(dataset.records, dataset.summaries);
  const matched: Array<{ record: TriageRecord; label: Label }> = [];
  for (const record of lastFailedAttempts(dataset.records)) {
    const candidates = labels.filter((l) => l.testId === record.testId && (!l.runId || l.runId === record.runId) && (l.retry === undefined || l.retry === record.retry));
    const label = candidates.find((l) => l.runId) ?? candidates[0];
    if (label) matched.push({ record, label });
  }
  const diagnoses = await diagnosePipeline(matched.map((m) => m.record), index, null);
  for (const [i, m] of matched.entries()) {
    const d = diagnoses[i];
    if (!d || d.category === 'UNKNOWN') continue;
    const rule = d.ruleId ?? '(no rule id)';
    const t = tallies.get(rule) ?? { rule, claimed: [], cases: 0, right: 0, datasets: new Set<string>() };
    t.claimed.push(d.confidence);
    t.cases += 1;
    if (d.category === m.label.label) t.right += 1;
    else (wrong[rule] = wrong[rule] ?? []).push(`${d.category} -> actually ${m.label.label}`);
    t.datasets.add(dataset.label);
    tallies.set(rule, t);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rows = [...tallies.values()].sort((a, b) => b.cases - a.cases);
console.log('');
console.log('  rule                                cases  right  observed  claimed    gap  projects');
for (const t of rows) {
  const observed = t.right / t.cases;
  const claimed = mean(t.claimed);
  const gap = (observed - claimed) * 100;
  console.log(
    `  ${t.rule.slice(0, 34).padEnd(34)} ${String(t.cases).padStart(5)}  ${String(t.right).padStart(5)}  ${(observed * 100).toFixed(1).padStart(7)}%  ${claimed.toFixed(2).padStart(7)}  ${(gap >= 0 ? '+' : '') + gap.toFixed(1)}%`.padEnd(96) + `  ${t.datasets.size}`,
  );
}
const cases = rows.reduce((s, t) => s + t.cases, 0);
const right = rows.reduce((s, t) => s + t.right, 0);
console.log('');
for (const [rule, misses] of Object.entries(wrong)) {
  const counts: Record<string, number> = {};
  for (const m of misses) counts[m] = (counts[m] ?? 0) + 1;
  console.log(`  ${rule}: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', ')}`);
}
console.log(`  ${'TOTAL'.padEnd(34)} ${String(cases).padStart(5)}  ${String(right).padStart(5)}  ${((right / cases) * 100).toFixed(1).padStart(7)}%`);
