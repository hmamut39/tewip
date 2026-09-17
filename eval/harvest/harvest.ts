// Harvests every finished Playwright CI run (passes and failures) of a public GitHub repo in
// a date window into data/real/<source>/ (gitignored): triage.jsonl + runs.jsonl in the
// reporter's format, attachments, and runs-meta.jsonl with GitHub facts for labelling.
// Passing runs matter: without them every test's history would look like "always fails".
// Usage: node eval/harvest/harvest.ts <source> --from YYYY-MM-DD --to YYYY-MM-DD [--dataset name] [--max-runs N] [--concurrency 4]
import { join } from 'node:path';
import { appendJsonl, datasetFiles, readJsonl } from '../../reporters/store.ts';
import { importBlobArtifacts } from '../../engine/import/blob.ts';
import { downloadArtifact, ghApi } from './gh.ts';

/** artifact: name prefix; every live artifact of a run starting with it is merged into that run. */
export const SOURCES: Record<string, { repo: string; workflow: string; artifact: string }> = {
  gutenberg: { repo: 'WordPress/gutenberg', workflow: 'end2end-test.yml', artifact: 'blob-reports-merged' },
  // Supabase Studio: one blob-report-next-N artifact per shard (the TanStack build runs the same tests and is left out).
  supabase: { repo: 'supabase/supabase', workflow: 'studio-e2e-test.yml', artifact: 'blob-report-next-' },
};

export interface RunMeta {
  runId: string;
  githubRunId: number;
  attempt: number;
  sha: string;
  branch: string;
  event: string;
  prNumbers: number[];
  createdAt: string;
  conclusion: string;
  imported: boolean;
  skipReason?: string;
  failureRecords?: number;
}

interface GhRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  created_at: string;
  conclusion: string;
  pull_requests: Array<{ number: number }>;
}

const flag = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i > 0 ? process.argv[i + 1] : undefined;
  if (value === undefined && fallback === undefined) throw new Error(`missing --${name}`);
  return value ?? fallback!;
};

/** runs-meta.jsonl of a dataset under data/real/ (named after the source unless --dataset is given). */
export const metaFile = (dataset: string) => join(datasetFiles(`data/real/${dataset}`).dir, 'runs-meta.jsonl');

async function listRuns(repo: string, workflow: string, from: string, to: string): Promise<GhRun[]> {
  const runs: GhRun[] = [];
  for (const conclusion of ['success', 'failure']) {
    for (let page = 1; page <= 10; page++) {
      const { workflow_runs } = await ghApi<{ workflow_runs: GhRun[] }>(
        `repos/${repo}/actions/workflows/${workflow}/runs?status=${conclusion}&created=${from}..${to}&per_page=100&page=${page}`,
      );
      runs.push(...workflow_runs);
      if (workflow_runs.length < 100) break;
    }
  }
  return runs.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function main(): Promise<void> {
  const source = process.argv[2];
  const config = SOURCES[source];
  if (!config) throw new Error(`usage: harvest.ts <${Object.keys(SOURCES).join('|')}> --from YYYY-MM-DD --to YYYY-MM-DD`);
  const from = flag('from');
  const to = flag('to');
  const maxRuns = Number(flag('max-runs', '1000'));
  const concurrency = Number(flag('concurrency', '4'));
  // A separate dataset name keeps e.g. a held-out window apart from the data used for tuning.
  const dataset = flag('dataset', source);

  const files = datasetFiles(`data/real/${dataset}`);
  // Only successful imports count as done; skipped runs are retried on the next harvest.
  const known = new Set(readJsonl<RunMeta>(metaFile(dataset)).filter((m) => m.imported).map((m) => m.runId));
  const runs = (await listRuns(config.repo, config.workflow, from, to))
    .filter((r) => !known.has(`${source}-${r.id}-a${r.run_attempt}`))
    .slice(0, maxRuns);
  console.log(`[harvest] ${runs.length} run(s) to import (${runs.filter((r) => r.conclusion === 'failure').length} failed)`);

  let done = 0;
  let records = 0;
  const importOne = async (run: GhRun) => {
    const runId = `${source}-${run.id}-a${run.run_attempt}`;
    const meta: RunMeta = {
      runId,
      githubRunId: run.id,
      attempt: run.run_attempt,
      sha: run.head_sha,
      branch: run.head_branch,
      event: run.event,
      prNumbers: run.pull_requests.map((p) => p.number),
      createdAt: run.created_at,
      conclusion: run.conclusion,
      imported: false,
    };
    try {
      const { artifacts } = await ghApi<{ artifacts: Array<{ id: number; name: string; expired: boolean }> }>(`repos/${config.repo}/actions/runs/${run.id}/artifacts?per_page=100`);
      const matching = artifacts.filter((a) => a.name.startsWith(config.artifact) && !a.expired);
      if (matching.length === 0) {
        appendJsonl(metaFile(dataset), [{ ...meta, skipReason: `no live ${config.artifact} artifact` }]);
        return;
      }
      const zips: Array<[string, Buffer]> = [];
      for (const a of matching) zips.push([a.name, await downloadArtifact(config.repo, a.id)]);
      const result = importBlobArtifacts(zips, { runId, gitSha: run.head_sha, branch: run.head_branch }, join(files.dir, 'files', String(run.id)));
      appendJsonl(files.triage, result.records);
      appendJsonl(files.runs, [result.summary]);
      appendJsonl(metaFile(dataset), [
        { ...meta, imported: true, failureRecords: result.records.length, ...(result.skippedShards.length ? { skipReason: `corrupt shard(s): ${result.skippedShards.join(', ')}` } : {}) },
      ]);
      records += result.records.length;
    } catch (error) {
      appendJsonl(metaFile(dataset), [{ ...meta, skipReason: `import failed: ${String(error).slice(0, 200)}` }]);
      console.warn(`[harvest] ${runId} skipped: ${String(error).slice(0, 200)}`);
    } finally {
      done++;
      if (done % 20 === 0 || done === runs.length) console.log(`[harvest] ${done}/${runs.length} runs processed, ${records} failure record(s) so far`);
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
      while (next < runs.length) await importOne(runs[next++]);
    }),
  );
  console.log(`[harvest] ${source}: done, ${records} failure record(s) into ${files.dir}`);
}

if (import.meta.main) await main();
