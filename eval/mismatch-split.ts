// Does `real-bug-assertion` get better when the test has passed before?
//
// Measured across the six labelled datasets: the rule fires 26 times and is right 10 - 38.5%, while
// claiming 0.78. It is the only rule in the set that is overconfident, and it is the one that
// accuses the application of being broken.
//
// The hypothesis is the one the README already applies to `env-server-error`: "that rule now steps
// back when a test has never passed, since there is then no baseline to say the backend was fine
// before." A regression needs a before. A test that has never passed and now fails the same way
// every time is a test that does not work, not a bug it has caught.
//
// This splits the firings by exactly that and prints both halves, so the change is made on the
// numbers rather than on the argument.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lastFailedAttempts, loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { readJsonl } from '../reporters/store.ts';
import type { TriageRecord } from '../reporters/types.ts';

interface Label { testId: string; runId?: string; retry?: number; label: string }
const DATASETS: Array<[string, string]> = [
  ['eval/ground-truth.jsonl', 'data/real/gutenberg'],
  ['eval/ground-truth.holdout.jsonl', 'data/real/gutenberg-holdout'],
  ['eval/ground-truth.fresh.jsonl', 'data/real/gutenberg-fresh'],
  ['eval/ground-truth.aug.jsonl', 'data/real/gutenberg-aug'],
  ['eval/ground-truth.aug2.jsonl', 'data/real/gutenberg-aug2'],
  ['eval/ground-truth.supabase.jsonl', 'data/real/supabase'],
];

const byStreak: Record<string, { n: number; right: number }> = {};
const longStreak = { n: 0, right: 0, projects: new Set<string>() };
const shortStreak = { n: 0, right: 0, projects: new Set<string>() };
const bucket = { passedBefore: { n: 0, right: 0, labels: {} as Record<string, number> }, neverPassed: { n: 0, right: 0, labels: {} as Record<string, number> } };

for (const [labelFile, dataDir] of DATASETS) {
  if (!existsSync(resolve(labelFile)) || !existsSync(resolve(dataDir))) continue;
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
    if (d?.ruleId !== 'real-bug-assertion') continue;
    const passes = Number(d.evidence?.[0]?.data?.passesBeforeStreak ?? 0);
    const streak = Number(d.evidence?.[0]?.data?.failingStreak ?? 0);
    const key = `streak ${streak >= 5 ? '5+' : streak}`;
    byStreak[key] = byStreak[key] ?? { n: 0, right: 0 };
    byStreak[key].n += 1;
    if (streak >= 2) { longStreak.n += 1; longStreak.projects.add(dataset.label); if (d.category === m.label.label) longStreak.right += 1; }
    else { shortStreak.n += 1; shortStreak.projects.add(dataset.label); if (d.category === m.label.label) shortStreak.right += 1; }
    if (d.category === m.label.label) byStreak[key].right += 1;
    const b = passes > 0 ? bucket.passedBefore : bucket.neverPassed;
    b.n += 1;
    if (d.category === m.label.label) b.right += 1;
    else b.labels[m.label.label] = (b.labels[m.label.label] ?? 0) + 1;
  }
}

const show = (name: string, b: typeof bucket.passedBefore) => {
  if (b.n === 0) return console.log(`  ${name.padEnd(28)} never fires`);
  const misses = Object.entries(b.labels).sort((a, c) => c[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', ');
  console.log(`  ${name.padEnd(28)} ${String(b.right).padStart(3)}/${String(b.n).padEnd(4)} ${((b.right / b.n) * 100).toFixed(1).padStart(6)}%   wrong: ${misses || 'none'}`);
};
console.log('');
console.log('  real-bug-assertion, split by whether the test had ever passed');
show('the test passed before', bucket.passedBefore);
show('the test never passed', bucket.neverPassed);
const all = bucket.passedBefore.n + bucket.neverPassed.n;
const right = bucket.passedBefore.right + bucket.neverPassed.right;
console.log('');
console.log('  does a longer failing streak earn the extra confidence?');
for (const k of Object.keys(byStreak).sort()) { const b = byStreak[k]; console.log(`  ${k.padEnd(28)} ${String(b.right).padStart(3)}/${String(b.n).padEnd(4)} ${((b.right/b.n)*100).toFixed(1).padStart(6)}%`); }
console.log('');
console.log('');
console.log(`  streak 1      ${shortStreak.right}/${shortStreak.n} across ${shortStreak.projects.size} project(s)`);
console.log(`  streak 2+     ${longStreak.right}/${longStreak.n} across ${longStreak.projects.size} project(s)`);
console.log(`  ${'both together'.padEnd(28)} ${String(right).padStart(3)}/${String(all).padEnd(4)} ${((right / all) * 100).toFixed(1).padStart(6)}%`);
