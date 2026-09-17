// Gathers labelling evidence for each harvested failure: facts the diagnosis pipeline does
// NOT see at triage time (later runs on the branch, what changed before the test passed
// again, whether the same test also fails on unrelated branches). Labels are decided from
// this evidence before the pipeline's answers are looked at.
// Usage: node eval/harvest/evidence.ts <source> [dataset name, default = source]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastFailedAttempts } from '../../engine/dataset.ts';
import { datasetFiles, readJsonl, readRunSummaries, readTriageRecords } from '../../reporters/store.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { ghApi } from './gh.ts';
import { metaFile, SOURCES, type RunMeta } from './harvest.ts';

export type Basis =
  | 'passed-on-retry' // same run, same code: a later attempt passed
  | 'recurs-on-unrelated-branches' // fails on several branches, passes elsewhere
  | 'fixed-by-app-change' // failing spec untouched, app code changed, then it passed
  | 'fixed-by-test-change' // only test code changed, then it passed
  | 'fixed-by-mixed-change'
  | 'unresolved'; // no later passing run on the branch in the window

export interface Evidence {
  runId: string;
  testId: string;
  retry: number;
  file: string;
  branch: string;
  event: string;
  basis: Basis;
  errorHead: string;
  facts: string[];
  stats: {
    createdAt: string;
    attemptsHere: number;
    failuresHere: number;
    /** Branches on which this test failed at least once in the window. */
    failedBranches: number;
    /** Earlier runs on this branch in which the test also failed. */
    earlierFailingRunsOnBranch: number;
    specTouched?: boolean;
    appFiles?: number;
    testFiles?: number;
  };
  /** Diff of the failing spec between the failing and the passing commit (test-change cases). */
  specPatch?: string;
}

interface Outcome {
  meta: RunMeta;
  attempts: number;
  failures: number;
}

/** Test code in most layouts: e2e / tests / playwright folders, *.spec / *.test files, e2e utils. */
const TEST_PATH = /(^|\/)(e2e|tests?|__tests__|playwright|specs?|e2e-test-utils[\w-]*)\/|\.(spec|test)\.[cm]?[jt]sx?$/;
/** Application code: source files in any language, excluding docs, config and lockfiles. */
const APP_PATH = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|php|go|py|rb|java|kt|cs|clj[sc]?|rs|css|scss|html)$/;

async function changedFiles(repo: string, base: string, head: string) {
  const cmp = await ghApi<{ files?: Array<{ filename: string; patch?: string }>; status: string }>(`repos/${repo}/compare/${base}...${head}`);
  const files = cmp.files ?? [];
  return {
    test: files.filter((f) => TEST_PATH.test(f.filename)),
    app: files.filter((f) => !TEST_PATH.test(f.filename) && APP_PATH.test(f.filename)),
    other: files.filter((f) => !TEST_PATH.test(f.filename) && !APP_PATH.test(f.filename)),
  };
}

async function main(): Promise<void> {
  const source = process.argv[2];
  const config = SOURCES[source];
  if (!config) throw new Error(`usage: evidence.ts <${Object.keys(SOURCES).join('|')}> [dataset]`);
  const dataset = process.argv[3] ?? source;
  const files = datasetFiles(`data/real/${dataset}`);
  const records = readTriageRecords(files.triage);
  const summaries = new Map(readRunSummaries(files.runs).map((s) => [s.runId, s]));
  const metas = readJsonl<RunMeta>(metaFile(dataset)).filter((m) => m.imported && summaries.has(m.runId));
  const failuresByRun = new Map<string, TriageRecord[]>();
  for (const r of records) failuresByRun.set(r.runId, [...(failuresByRun.get(r.runId) ?? []), r]);

  const outcomesOf = (testId: string): Outcome[] =>
    metas
      .map((meta) => ({
        meta,
        attempts: summaries.get(meta.runId)!.attempts[testId] ?? 0,
        failures: (failuresByRun.get(meta.runId) ?? []).filter((f) => f.testId === testId).length,
      }))
      .filter((o) => o.attempts > 0)
      .sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt));

  const out: Evidence[] = [];
  for (const record of lastFailedAttempts(records)) {
    const meta = metas.find((m) => m.runId === record.runId);
    if (!meta) continue;
    const history = outcomesOf(record.testId);
    const here = history.find((o) => o.meta.runId === record.runId)!;
    const failedBranches = new Set(history.filter((o) => o.failures > 0).map((o) => o.meta.branch));
    const passedSomewhere = history.some((o) => o.failures < o.attempts);
    const facts = [
      `run ${meta.githubRunId} (${meta.event}, branch ${meta.branch}, ${meta.createdAt}); ${here.failures}/${here.attempts} attempts failed`,
      `test failed on ${failedBranches.size} branch(es) in the window: ${[...failedBranches].slice(0, 5).join(', ')}`,
      `overall: failed in ${history.filter((o) => o.failures > 0).length} of ${history.length} runs`,
    ];
    const stats: Evidence['stats'] = {
      createdAt: meta.createdAt,
      attemptsHere: here.attempts,
      failuresHere: here.failures,
      failedBranches: failedBranches.size,
      earlierFailingRunsOnBranch: history.filter((o) => o.meta.branch === meta.branch && o.meta.createdAt < meta.createdAt && o.failures > 0).length,
    };
    const base = {
      runId: record.runId,
      testId: record.testId,
      retry: record.retry,
      file: record.file,
      branch: meta.branch,
      event: meta.event,
      errorHead: record.errorMessage.split('\n').slice(0, 4).join(' | ').slice(0, 300),
      facts,
      stats,
    };

    const sameShaPass = history.find((o) => o.meta.sha === meta.sha && o.meta.runId !== meta.runId && o.failures < o.attempts);
    if (here.failures < here.attempts || sameShaPass) {
      if (sameShaPass) facts.push(`passed on the same commit in run ${sameShaPass.meta.githubRunId}`);
      out.push({ ...base, basis: 'passed-on-retry' });
      continue;
    }
    if (failedBranches.size >= 3 && passedSomewhere) {
      out.push({ ...base, basis: 'recurs-on-unrelated-branches' });
      continue;
    }

    const later = history.find((o) => o.meta.branch === meta.branch && o.meta.createdAt > meta.createdAt && o.failures < o.attempts);
    if (!later) {
      out.push({ ...base, basis: 'unresolved' });
      continue;
    }
    const diff = await changedFiles(config.repo, meta.sha, later.meta.sha);
    const specTouched = diff.test.filter((f) => record.file && f.filename.endsWith(record.file));
    facts.push(
      `passed again in run ${later.meta.githubRunId} (${later.meta.createdAt}); changed in between: ${diff.app.length} app, ${diff.test.length} test, ${diff.other.length} other file(s); failing spec ${specTouched.length ? 'CHANGED' : 'unchanged'}`,
      `app files: ${diff.app.slice(0, 6).map((f) => f.filename).join(', ') || '-'}`,
    );
    Object.assign(stats, { specTouched: specTouched.length > 0, appFiles: diff.app.length, testFiles: diff.test.length });
    const basis: Basis = specTouched.length === 0 && diff.app.length > 0 ? 'fixed-by-app-change' : specTouched.length > 0 && diff.app.length === 0 ? 'fixed-by-test-change' : 'fixed-by-mixed-change';
    out.push({ ...base, basis, specPatch: specTouched.map((f) => f.patch ?? '').join('\n').slice(0, 4000) || undefined });
  }

  const target = join(files.dir, 'evidence.jsonl');
  writeFileSync(target, out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const counts = out.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.basis]: (acc[e.basis] ?? 0) + 1 }), {});
  console.log(`[evidence] ${out.length} case(s) written to ${target}`);
  console.log(counts);
}

if (import.meta.main) await main();
