// Loading a dataset and turning failed attempts into cases. Shared by the eval, the
// evidence harvester and the outlets.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { datasetFiles, PROJECT_ROOT, readJsonl, readRunSummaries, readTriageRecords } from '../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../reporters/types.ts';

export interface Dataset {
  records: TriageRecord[];
  summaries: RunSummary[];
  /** Where the data came from, shown next to every number and diagnosis. */
  label: string;
}

/**
 * One case per failed test per run: its last failed attempt. Retries of the same failure
 * share one cause, so counting each would weight a test by its retry count.
 */
export function lastFailedAttempts(records: TriageRecord[]): TriageRecord[] {
  const last = new Map<string, TriageRecord>();
  for (const r of records) {
    const key = `${r.runId} ${r.testId}`;
    const seen = last.get(key);
    if (!seen || r.retry > seen.retry) last.set(key, r);
  }
  return [...last.values()];
}

/** Harvested datasets predate RunSummary.branch: fill it from the harvester's runs-meta.jsonl. */
function withBranches(summaries: RunSummary[], dir: string): RunSummary[] {
  const metaFile = join(dir, 'runs-meta.jsonl');
  if (!existsSync(metaFile)) return summaries;
  const branch = new Map(readJsonl<{ runId: string; branch?: string }>(metaFile).map((m) => [m.runId, m.branch ?? '']));
  return summaries.map((s) => (s.branch || !branch.get(s.runId) ? s : { ...s, branch: branch.get(s.runId) }));
}

/** Records + run summaries from a dataset dir, or from every dataset directly under it. */
export function loadDataset(dir?: string): Dataset {
  const files = datasetFiles(dir);
  if (!dir || existsSync(files.triage)) {
    return { records: readTriageRecords(files.triage), summaries: withBranches(readRunSummaries(files.runs), files.dir), label: relative(PROJECT_ROOT, files.dir).replaceAll('\\', '/') || '.' };
  }
  const subdirs = readdirSync(files.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(files.dir, d.name, 'triage.jsonl')));
  const parts = subdirs.map((d) => datasetFiles(join(files.dir, d.name)));
  return {
    records: parts.flatMap((p) => readTriageRecords(p.triage)),
    summaries: parts.flatMap((p) => withBranches(readRunSummaries(p.runs), p.dir)),
    label: subdirs.map((d) => relative(PROJECT_ROOT, join(files.dir, d.name)).replaceAll('\\', '/')).join(', '),
  };
}
