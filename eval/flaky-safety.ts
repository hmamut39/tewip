// Does `tewip flaky` ever tell you to quarantine a test that was catching a real bug?
//
// Quarantining is the one recommendation in Tewip that silently removes a signal: the test keeps
// existing, keeps appearing in the count, and stops blocking anything. Getting it wrong does not
// produce a wrong answer on screen, it produces a bug in production months later with no trace back
// to the decision.
//
// There is ground truth for this. Across six datasets, 2,773 real CI failures carry a hand label
// saying what each one actually was. So the question has an answer rather than an argument: of the
// tests `flaky` says to quarantine, how many have failures a person labelled REAL_BUG?
//
// A test whose failures are labelled TIMING is exactly what quarantine is for. One with REAL_BUG
// failures is a test doing its job, and hiding it is the worst thing this command can do.
//
// Usage: node eval/flaky-safety.ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { flakyTests } from '../engine/flaky/flaky.ts';
import { readJsonl, readRunSummaries, readTriageRecords } from '../reporters/store.ts';

interface Label { testId: string; runId?: string; label: string }

const DATASETS: Array<[string, string]> = [
  ['eval/ground-truth.jsonl', 'data/real/gutenberg'],
  ['eval/ground-truth.holdout.jsonl', 'data/real/gutenberg-holdout'],
  ['eval/ground-truth.fresh.jsonl', 'data/real/gutenberg-fresh'],
  ['eval/ground-truth.aug.jsonl', 'data/real/gutenberg-aug'],
  ['eval/ground-truth.aug2.jsonl', 'data/real/gutenberg-aug2'],
  ['eval/ground-truth.supabase.jsonl', 'data/real/supabase'],
];

const NL = String.fromCharCode(10);
let quarantined = 0;
let withRealBug = 0;
let labelledAtAll = 0;
const offenders: string[] = [];
const verdictCounts: Record<string, number> = {};
const realBugTests: Record<string, number> = {};

for (const [labelFile, dataDir] of DATASETS) {
  if (!existsSync(resolve(labelFile)) || !existsSync(resolve(dataDir))) continue;
  const labels = readJsonl<Label>(resolve(labelFile));
  const records = readTriageRecords(resolve(dataDir, 'triage.jsonl'));
  const runs = readRunSummaries(resolve(dataDir, 'runs.jsonl'));

  // What a person said about each test, across every failure of it they labelled.
  const byTest = new Map<string, string[]>();
  for (const l of labels) byTest.set(l.testId, [...(byTest.get(l.testId) ?? []), l.label]);

  for (const test of flakyTests(records, runs)) {
    verdictCounts[test.verdict] = (verdictCounts[test.verdict] ?? 0) + 1;
    // The other direction: what does it say about the tests that really were catching bugs?
    const theirLabels = byTest.get(test.testId) ?? [];
    if (theirLabels.includes('REAL_BUG')) realBugTests[test.verdict] = (realBugTests[test.verdict] ?? 0) + 1;
    if (test.verdict !== 'quarantine') continue;
    quarantined += 1;
    const said = byTest.get(test.testId);
    if (!said || said.length === 0) continue;
    labelledAtAll += 1;
    const bugs = said.filter((l) => l === 'REAL_BUG').length;
    if (bugs > 0) {
      withRealBug += 1;
      offenders.push(`  ${dataDir.split('/').pop()}: ${test.title.slice(0, 54)} - ${bugs} of ${said.length} failure(s) labelled REAL_BUG`);
    }
  }
}

console.log('');
console.log('# Would quarantining hide a real bug?');
console.log('');
console.log(`Verdicts across all six datasets: ${Object.entries(verdictCounts).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log('');
console.log(`Tests recommended for quarantine:        ${quarantined}`);
console.log(`  of those, a person labelled a failure: ${labelledAtAll}`);
console.log(`  of those, any labelled REAL_BUG:       ${withRealBug}`);
console.log(`Tests with a REAL_BUG label, by what flaky said: ${Object.entries(realBugTests).map(([k, n]) => `${k} ${n}`).join(', ') || 'none found'}`);
console.log('');
if (offenders.length > 0) {
  console.log('## Quarantine would have hidden these');
  console.log('');
  console.log(offenders.join(NL));
} else if (labelledAtAll === 0) {
  console.log('Nothing is claimed: no quarantined test had a labelled failure, so this says nothing.');
} else {
  console.log(`No test recommended for quarantine has a failure anybody labelled a real bug (${labelledAtAll} checked).`);
}
