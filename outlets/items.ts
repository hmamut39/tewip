// The unified triage item: one per failed test per run, built once by the engine and
// rendered by every role's view (ROADMAP principle 3: one engine, many outlets).
import { extractLocator } from '../engine/error-parse.ts';
import { decide, type PlannedAction } from '../engine/decide.ts';
import { lastFailedAttempts } from '../engine/dataset.ts';
import type { HistoryIndex, TestHistory } from '../engine/history.ts';
import type { LlmClient } from '../engine/llm/client.ts';
import { failingCodeOf } from '../engine/llm/context.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { truncate } from '../engine/signature.ts';
import type { Diagnosis, TriageRecord } from '../reporters/types.ts';
import { designDebt, type DesignDebt } from './design-debt.ts';

export type Relation = 'likely-this-change' | 'not-this-change' | 'unclear';

export interface TriageItem {
  runId: string;
  testId: string;
  /** Last segment of the test id: the test's own title. */
  title: string;
  file: string;
  /** Area of the product the test covers, from its spec path (e.g. "editor/blocks"). */
  component: string;
  commit: string;
  timestamp: string;
  /** Failed attempts of this test in this run, and the CI time they took. */
  failedAttempts: number;
  wastedMs: number;
  errorHead: string;
  diagnosis: Diagnosis;
  action: PlannedAction;
  /** "rules rules-2" or "AI gpt-5.4-mini (reasoning low)", plus the dataset. Shown with every diagnosis. */
  source: string;
  evidence: string[];
  recoveredOnRetry: boolean;
  /** For developers: did this change cause it? */
  relation: { verdict: Relation; why: string };
  debt: DesignDebt[];
  locator?: string;
}

/** Product area from a spec path: its first two folders, or the spec name when it has none. */
export function componentOf(file: string): string {
  const path = file.replaceAll('\\', '/').replace(/^(?:test\/e2e\/specs|tests?|e2e|specs?)\//, '');
  const dirs = path.split('/').slice(0, -1);
  return dirs.length > 0 ? dirs.slice(0, 2).join('/') : path.replace(/\.(spec|test)\.[jt]sx?$/, '');
}

function relationOf(d: Diagnosis, h: TestHistory): TriageItem['relation'] {
  if (d.category === 'ENV') return { verdict: 'not-this-change', why: 'environment problem, not code (see the infrastructure view)' };
  if (h.currentRunFailures < h.currentRunAttempts) return { verdict: 'not-this-change', why: 'a retry of the same code passed in this run: the test is flaky' };
  if (h.failingRunsOnOtherCommits >= 2) return { verdict: 'not-this-change', why: `it also failed in ${h.failingRunsOnOtherCommits} runs on other commits: an existing problem` };
  if (h.sameCommitAttempts > 0 && h.sameCommitFailures === h.sameCommitAttempts && h.passesOnOtherCommits > 0) {
    return { verdict: 'likely-this-change', why: `every attempt on this commit failed (${h.sameCommitFailures}/${h.sameCommitAttempts}) while it passed ${h.passesOnOtherCommits} time(s) on other commits` };
  }
  return { verdict: 'unclear', why: 'not enough history on other commits to tell' };
}

export function sourceOf(d: Diagnosis, dataset: string): string {
  const who = d.source === 'llm' ? `AI ${d.model ?? 'model'}` : `rules ${d.engineVersion}`;
  return `${who} · data: ${dataset}`;
}

function suggestedLocator(d: Diagnosis): string | undefined {
  const candidate = d.evidence.map((e) => e.data?.candidate as { role?: string; name?: string } | undefined).find(Boolean);
  if (!candidate?.role) return undefined;
  return candidate.name ? `getByRole('${candidate.role}', { name: '${candidate.name.replaceAll("'", "\\'")}' })` : `getByRole('${candidate.role}')`;
}

export interface BuildOptions {
  /** Shown next to every diagnosis as its data source. */
  dataset: string;
  llm: LlmClient | null;
}

/** Diagnoses every failed test of every run in `records` and wraps each as a TriageItem. */
export async function buildItems(records: TriageRecord[], index: HistoryIndex, { dataset, llm }: BuildOptions): Promise<TriageItem[]> {
  const cases = lastFailedAttempts(records);
  const diagnoses = await diagnosePipeline(cases, index, llm);
  const failedAttempts = new Map<string, TriageRecord[]>();
  for (const r of records) failedAttempts.set(`${r.runId} ${r.testId}`, [...(failedAttempts.get(`${r.runId} ${r.testId}`) ?? []), r]);

  return cases.map((record, i) => {
    const d = diagnoses[i];
    const history = index.historyAsOf(record.testId, record.runId);
    const attempts = failedAttempts.get(`${record.runId} ${record.testId}`) ?? [record];
    const locator = extractLocator(record.errorMessage) ?? undefined;
    const debt = designDebt(locator ?? null, failingCodeOf(record));
    const component = componentOf(record.file);
    const hardWait = debt.find((x) => x.kind === 'hard-wait')?.detail;
    return {
      runId: record.runId,
      testId: record.testId,
      title: record.testId.split(' > ').at(-1) ?? record.testId,
      file: record.file,
      component,
      commit: record.gitSha,
      timestamp: record.timestamp,
      failedAttempts: attempts.length,
      wastedMs: attempts.reduce((sum, a) => sum + a.duration, 0),
      errorHead: truncate(record.errorMessage.split('\n')[0] ?? '', 160),
      diagnosis: d,
      action: decide(d, {
        locator,
        suggestedLocator: suggestedLocator(d),
        hardWait,
        component,
        commit: record.gitSha,
        tracePath: record.attachments.find((a) => a.name === 'trace')?.path,
      }),
      source: sourceOf(d, dataset),
      evidence: d.evidence.slice(0, 3).map((e) => truncate(e.message, 220)),
      recoveredOnRetry: history.currentRunFailures < history.currentRunAttempts,
      relation: relationOf(d, history),
      debt,
      locator,
    };
  });
}
