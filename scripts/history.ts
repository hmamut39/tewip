// Aggregates data/triage.jsonl (+ data/runs.jsonl for run counts) per testId and prints a table.
import { relative } from 'node:path';
import { FLAKY_MAX_RATE, FLAKY_MIN_RATE } from '../engine/rules.ts';
import { errorSignature } from '../engine/signature.ts';
import { PROJECT_ROOT, readRunSummaries, readTriageRecords, TRIAGE_FILE } from '../reporters/store.ts';
import type { TriageRecord } from '../reporters/types.ts';
import { renderTable } from './table.ts';

export interface TestHistory {
  testId: string;
  runs: number;
  failures: number;
  failureRate: number;
  lastFailureAt: string | null;
  /** Distinct error signatures across failures (0 when the test never failed). */
  distinctErrors: number;
  suspectedFlaky: boolean;
}

export function aggregate(records: TriageRecord[], attemptsByRun: Map<string, Record<string, number>>): TestHistory[] {
  const runs = new Map<string, number>();
  for (const attempts of attemptsByRun.values()) {
    for (const [testId, n] of Object.entries(attempts)) runs.set(testId, (runs.get(testId) ?? 0) + n);
  }

  const failuresByTest = new Map<string, TriageRecord[]>();
  for (const record of records) {
    const list = failuresByTest.get(record.testId) ?? [];
    list.push(record);
    failuresByTest.set(record.testId, list);
    // A failure from a run with no summary line still proves one attempt happened.
    if (!attemptsByRun.has(record.runId)) runs.set(record.testId, (runs.get(record.testId) ?? 0) + 1);
  }

  const testIds = new Set([...runs.keys(), ...failuresByTest.keys()]);
  return [...testIds].map((testId) => {
    const failures = failuresByTest.get(testId) ?? [];
    const total = Math.max(runs.get(testId) ?? 0, failures.length);
    const failureRate = total === 0 ? 0 : failures.length / total;
    const distinctErrors = new Set(failures.map((f) => errorSignature(f.errorMessage))).size;
    const lastFailureAt = failures.reduce<string | null>((max, f) => (max === null || f.timestamp > max ? f.timestamp : max), null);
    return {
      testId,
      runs: total,
      failures: failures.length,
      failureRate,
      lastFailureAt,
      distinctErrors,
      suspectedFlaky: failureRate >= FLAKY_MIN_RATE && failureRate <= FLAKY_MAX_RATE && distinctErrors > 1,
    };
  });
}

function main(): void {
  const records = readTriageRecords();
  const summaries = readRunSummaries();
  const attemptsByRun = new Map<string, Record<string, number>>();
  for (const s of summaries) {
    // Merge in case the same runId (e.g. a reused CI_RUN_ID) appears more than once.
    const merged = { ...attemptsByRun.get(s.runId) };
    for (const [testId, n] of Object.entries(s.attempts)) merged[testId] = (merged[testId] ?? 0) + n;
    attemptsByRun.set(s.runId, merged);
  }

  const dataFile = relative(PROJECT_ROOT, TRIAGE_FILE).replaceAll('\\', '/');
  if (records.length === 0 && summaries.length === 0) {
    console.log(`No data yet in ${dataFile}. Run \`npm test\` or \`npm run test:loop\` first.`);
    return;
  }

  const stats = aggregate(records, attemptsByRun).sort(
    (a, b) => b.failureRate - a.failureRate || b.failures - a.failures || a.testId.localeCompare(b.testId),
  );

  const headers = ['Test ID', 'Runs', 'Fails', 'Fail %', 'Last failure (UTC)', 'Same error?', 'Flag'];
  const rows = stats.map((s) => [
    s.testId,
    String(s.runs),
    String(s.failures),
    `${(s.failureRate * 100).toFixed(0)}%`,
    s.lastFailureAt ? s.lastFailureAt.replace('T', ' ').slice(0, 19) : '-',
    s.failures === 0 ? '-' : s.distinctErrors === 1 ? 'yes' : `no (${s.distinctErrors} variants)`,
    s.suspectedFlaky ? 'SUSPECTED_FLAKY' : '',
  ]);

  console.log(renderTable(headers, rows, new Set([1, 2, 3])));
  console.log(`\n${records.length} failure record(s) in ${dataFile}, ${attemptsByRun.size} run(s) in data/runs.jsonl.`);
  console.log(`SUSPECTED_FLAKY = failure rate ${FLAKY_MIN_RATE * 100}%-${FLAKY_MAX_RATE * 100}% and error message not the same every time.`);
}

if (import.meta.main) main();
