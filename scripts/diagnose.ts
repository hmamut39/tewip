// Runs the phase-2 rule engine over every collected failure and prints the phase metric:
// coverage = share of failures the rules classify (anything but UNKNOWN).
// Each failure is judged with point-in-time history: only runs up to and including its own.
// Usage: node scripts/diagnose.ts [--evidence]
import { relative } from 'node:path';
import { diagnoseRecords, ENGINE_VERSION } from '../engine/engine.ts';
import { HistoryIndex } from '../engine/history.ts';
import { truncate } from '../engine/signature.ts';
import { PROJECT_ROOT, readRunSummaries, readTriageRecords, TRIAGE_FILE } from '../reporters/store.ts';
import { ROOT_CAUSES, type Diagnosis, type TriageRecord } from '../reporters/types.ts';
import { renderTable } from './table.ts';

const COVERAGE_TARGET = 0.5;

/** The pipeline-debug specs in tests/. Numbers computed on them are never product metrics. */
const SYNTHETIC_SPECS = new Set([
  'tests/assertion.spec.ts',
  'tests/flaky.spec.ts',
  'tests/missing-selector.spec.ts',
  'tests/network.spec.ts',
  'tests/timeout.spec.ts',
]);

interface Row {
  record: TriageRecord;
  diagnosis: Diagnosis;
  run: number;
}

function datasetLabel(records: TriageRecord[]): string {
  const synthetic = records.filter((r) => SYNTHETIC_SPECS.has(r.file)).length;
  if (synthetic === records.length) return 'SYNTHETIC: every record comes from the pipeline-debug specs in tests/. NOT a product metric.';
  if (synthetic === 0) return 'no records from the synthetic specs (source of the data not verified here).';
  return `MIXED: ${synthetic} of ${records.length} records come from the synthetic specs in tests/. NOT a product metric.`;
}

function coverage(rows: Row[]): { decided: number; total: number; ratio: number } {
  const decided = rows.filter((r) => r.diagnosis.category !== 'UNKNOWN').length;
  return { decided, total: rows.length, ratio: rows.length === 0 ? 0 : decided / rows.length };
}

const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

function main(): void {
  const showEvidence = process.argv.includes('--evidence');
  const records = readTriageRecords();
  const dataFile = relative(PROJECT_ROOT, TRIAGE_FILE).replaceAll('\\', '/');
  if (records.length === 0) {
    console.log(`No failure records in ${dataFile}. Run \`npm test\` or \`npm run test:loop\` first.`);
    return;
  }

  const index = new HistoryIndex(records, readRunSummaries());
  const runNumber = new Map(index.runIds.map((id, i) => [id, i + 1]));
  const diagnoses = diagnoseRecords(records, index);
  const rows: Row[] = records
    .map((record, i) => ({ record, diagnosis: diagnoses[i], run: runNumber.get(record.runId)! }))
    .sort((a, b) => a.run - b.run || a.record.testId.localeCompare(b.record.testId));

  console.log(`Rule engine ${ENGINE_VERSION}. Each failure is judged with history up to its own run only.\n`);
  const table = rows.map(({ record, diagnosis, run }) => [
    `#${run}`,
    record.testId,
    diagnosis.category,
    diagnosis.category === 'UNKNOWN' ? '-' : diagnosis.confidence.toFixed(2),
    truncate(diagnosis.evidence[0]?.message ?? '', 90),
  ]);
  console.log(renderTable(['Run', 'Test ID', 'Category', 'Conf', 'Why (first evidence line)'], table, new Set([3])));

  if (showEvidence) {
    for (const { record, diagnosis, run } of rows) {
      console.log(`\n#${run} ${record.testId} → ${diagnosis.category}${diagnosis.ruleId ? ` (${diagnosis.ruleId})` : ''}`);
      for (const e of diagnosis.evidence) console.log(`   [${e.source}] ${e.message}`);
    }
  }

  const counts = [...ROOT_CAUSES, 'UNKNOWN'].map((c) => `${c} ${rows.filter((r) => r.diagnosis.category === c).length}`);
  console.log(`\nBy category: ${counts.join(', ')}`);

  const all = coverage(rows);
  const latestRun = index.runIds.length;
  const latest = coverage(rows.filter((r) => r.run === latestRun));
  const met = all.ratio >= COVERAGE_TARGET;

  console.log(`\nDataset: ${dataFile}, ${records.length} failure records from ${index.runIds.length} runs.`);
  console.log(`         ${datasetLabel(records)}`);
  console.log(`Phase 2 metric, coverage over all records: ${all.decided}/${all.total} = ${percent(all.ratio)}  ` +
    `(target >= ${percent(COVERAGE_TARGET)}: ${met ? 'MET' : 'MISSED'})`);
  console.log(`Coverage of the latest run (#${latestRun}) alone: ${latest.decided}/${latest.total} = ${percent(latest.ratio)}`);
  console.log(`${all.total - all.decided} UNKNOWN record(s) are left for the phase-3 LLM layer.`);
}

if (import.meta.main) main();
