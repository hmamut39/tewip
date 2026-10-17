// What does "expected 4, received 3" actually mean on a real browser suite?
//
// This exists because of a wrong recommendation. Phase 64 found that `tewip bugs` files almost
// nothing - 1 ticket out of 1,964 real failures - because `real-bug-assertion` declines a value
// mismatch on a test's first recorded run, which is every test in a single CI run. The suggested fix
// was to let the rules call a plain value mismatch a real bug without history: "expected 4, received
// 3 needs no model" is an obvious-sounding argument.
//
// It is wrong, and this measures by how much. Over 2,767 hand-labelled real failures, a value
// mismatch is **TIMING nine times out of ten**. A flaky test fails its assertion; that is what
// failing looks like. The signal that separates a real bug from a flaky one is not the mismatch, it
// is the history around it - a stable failing streak with no earlier flakiness - which is exactly
// what the rule already requires and exactly what one CI run cannot supply.
//
// Kept as a script rather than a note so the claim can be re-derived rather than believed. The label
// files are not in the repository (they are a team's own data and are never committed), so this
// prints what is missing rather than a number from nothing.
//
// Usage: node eval/mismatch-precision.ts [--verbose]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { valueMismatch } from '../engine/error-parse.ts';
import { PROJECT_ROOT } from '../reporters/store.ts';

/** Each labelled set beside the collected failures it was labelled from. */
const SETS: ReadonlyArray<{ labels: string; dataset: string }> = [
  { labels: 'ground-truth.jsonl', dataset: 'gutenberg' },
  { labels: 'ground-truth.aug.jsonl', dataset: 'gutenberg-aug' },
  { labels: 'ground-truth.aug2.jsonl', dataset: 'gutenberg-aug2' },
  { labels: 'ground-truth.fresh.jsonl', dataset: 'gutenberg-fresh' },
  { labels: 'ground-truth.holdout.jsonl', dataset: 'gutenberg-holdout' },
  { labels: 'ground-truth.gutenberg-local.jsonl', dataset: 'gutenberg-local' },
  { labels: 'ground-truth.supabase.jsonl', dataset: 'supabase' },
  { labels: 'ground-truth.jupyterlab.jsonl', dataset: 'jupyterlab' },
  { labels: 'ground-truth.lxdui.jsonl', dataset: 'lxdui' },
  { labels: 'ground-truth.penpot.jsonl', dataset: 'penpot' },
];

interface Label {
  testId: string;
  runId?: string;
  label: string;
}

const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
const parse = <T>(file: string): T[] => lines(file).map((l) => JSON.parse(l) as T);

/** One set's count of value mismatches, and what each turned out to be. */
export interface SetResult {
  dataset: string;
  mismatches: number;
  byLabel: Map<string, number>;
}

export function measureSet(labelFile: string, recordFile: string, dataset: string): SetResult {
  const records = parse<{ testId: string; runId: string; errorMessage?: string }>(recordFile);
  // A label may name one attempt or the test as a whole, so both lookups are kept.
  const byAttempt = new Map<string, string>();
  const byTest = new Map<string, string>();
  for (const r of records) {
    byAttempt.set(`${r.testId}::${r.runId}`, r.errorMessage ?? '');
    if (!byTest.has(r.testId)) byTest.set(r.testId, r.errorMessage ?? '');
  }

  const byLabel = new Map<string, number>();
  let mismatches = 0;
  for (const label of parse<Label>(labelFile)) {
    const message = (label.runId ? byAttempt.get(`${label.testId}::${label.runId}`) : undefined) ?? byTest.get(label.testId);
    if (message === undefined || !valueMismatch(message)) continue;
    mismatches += 1;
    byLabel.set(label.label, (byLabel.get(label.label) ?? 0) + 1);
  }
  return { dataset, mismatches, byLabel };
}

function main(): void {
  const results: SetResult[] = [];
  const missing: string[] = [];
  for (const { labels, dataset } of SETS) {
    const labelFile = join(PROJECT_ROOT, 'eval', labels);
    const recordFile = join(PROJECT_ROOT, 'data', 'real', dataset, 'triage.jsonl');
    if (!existsSync(labelFile) || !existsSync(recordFile)) {
      missing.push(`${labels} + data/real/${dataset}/triage.jsonl`);
      continue;
    }
    results.push(measureSet(labelFile, recordFile, dataset));
  }

  if (results.length === 0) {
    console.log('No labelled set is present here, so nothing was measured.');
    console.log('Each set needs both halves, and neither is committed:');
    for (const m of missing) console.log(`  - ${m}`);
    console.log('\nHarvest with eval/harvest/harvest.ts and label with eval/harvest/label.ts.');
    return;
  }

  console.log('What a value mismatch turned out to be, per project');
  console.log('(a hand-labelled real failure whose error text carries "expected X, received Y")\n');
  let total = 0;
  const overall = new Map<string, number>();
  for (const r of results.filter((r) => r.mismatches > 0)) {
    total += r.mismatches;
    for (const [k, v] of r.byLabel) overall.set(k, (overall.get(k) ?? 0) + v);
    const bugs = r.byLabel.get('REAL_BUG') ?? 0;
    const breakdown = [...r.byLabel].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`  ${r.dataset.padEnd(20)} ${String(r.mismatches).padStart(4)} mismatches, ${String(bugs).padStart(3)} REAL_BUG = ${((bugs / r.mismatches) * 100).toFixed(1)}%   [${breakdown}]`);
  }

  const bugs = overall.get('REAL_BUG') ?? 0;
  console.log(`\n  ${'all sets'.padEnd(20)} ${String(total).padStart(4)} mismatches, ${String(bugs).padStart(3)} REAL_BUG = ${((bugs / Math.max(total, 1)) * 100).toFixed(1)}%`);
  for (const [k, v] of [...overall].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${k.padEnd(12)} ${String(v).padStart(4)}  ${((v / Math.max(total, 1)) * 100).toFixed(1)}%`);
  }
  console.log(
    '\nA value mismatch on its own is not evidence of a bug: a flaky test fails its assertion too,' +
      '\nand that is what most of these are. `real-bug-assertion` declines without a stable failing' +
      '\nstreak for this reason, which is also why `tewip bugs` has little to file from one CI run.',
  );
  if (missing.length > 0) console.log(`\n${missing.length} set(s) were not present here and were not measured.`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
