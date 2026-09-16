// GitHub Action entry point (see action.yml). After a Playwright run with the built-in `blob`
// reporter: import the report, diagnose every failure with the run history kept in the Actions
// cache, write every role's view, post the developer PR comment, group environment failures
// into one issue, optionally open a verified locator-fix PR, and save the history back.
// It never fails the workflow itself: the test step already carries the pass/fail status.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HistoryIndex } from '../engine/history.ts';
import { importBlobReportDir } from '../engine/import/blob.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { buildItems } from '../outlets/items.ts';
import { prCommentView } from '../outlets/views/developer.ts';
import { infraView } from '../outlets/views/infra.ts';
import { releaseView } from '../outlets/views/release.ts';
import { sdetBoardView } from '../outlets/views/sdet.ts';
import { datasetFiles, readRunSummaries, readTriageRecords } from '../reporters/store.ts';
import type { FixResult } from '../engine/autofix/autofix.ts';
import { readCiContext } from './context.ts';
import { autofixAndOpenPr } from './fix-pr.ts';
import { GitHub, type IssueRef } from './github.ts';
import { postEnvIssue, postPrComment, prCommentBody, writeStepSummary } from './publish.ts';

/** Runs of history kept in the cache; older ones are dropped. */
const MAX_HISTORY_RUNS = 300;

const log = (message: string) => console.log(`[triage-agent] ${message}`);
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`::warning::triage-agent ${name} failed: ${String(error).slice(0, 400)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const ctx = readCiContext();
  mkdirSync(ctx.outDir, { recursive: true });
  mkdirSync(ctx.historyDir, { recursive: true });
  if (!existsSync(ctx.blobDir)) {
    log(`no blob report at ${ctx.blobDir}. Add Playwright's blob reporter: reporter: [['list'], ['blob']]`);
    return;
  }

  const imported = importBlobReportDir(ctx.blobDir, { runId: ctx.runId, gitSha: ctx.sha, branch: ctx.branch, workspace: ctx.workspace }, join(ctx.outDir, 'files'));
  const history = datasetFiles(ctx.historyDir);
  const pastRecords = readTriageRecords(history.triage).filter((r) => r.runId !== ctx.runId);
  const pastRuns = readRunSummaries(history.runs).filter((s) => s.runId !== ctx.runId);
  const index = new HistoryIndex([...pastRecords, ...imported.records], [...pastRuns, imported.summary]);
  log(`imported ${imported.records.length} failed attempt(s); history: ${pastRuns.length} earlier run(s)`);

  const llm = llmFromEnv();
  const items = await buildItems(imported.records, index, { dataset: `${ctx.repo} CI`, llm });
  const views = [prCommentView, sdetBoardView, infraView, releaseView].map((view) => view(items, ctx.runId, ctx.repo));
  for (const v of views) writeFileSync(join(ctx.outDir, `${v.id}.md`), v.markdown, 'utf8');
  writeStepSummary(ctx, items);

  const github = ctx.token ? new GitHub(ctx.token, ctx.repo, ctx.apiUrl) : null;
  let fixes: FixResult[] = [];
  let fixPr: IssueRef | null = null;
  if (github && ctx.autofix && items.some((i) => i.action.kind === 'fix-locator' && i.action.autonomous)) {
    const result = await step('auto-fix', () => autofixAndOpenPr(ctx, github, items, imported.records));
    fixes = result?.fixes ?? [];
    fixPr = result?.pr ?? null;
    if (fixPr) log(`opened fix PR ${fixPr.html_url}`);
  }
  if (github) {
    const comment = await step('PR comment', () => postPrComment(ctx, github, prCommentBody(ctx, items, fixPr, fixes)));
    if (comment) log(`PR comment: ${comment}`);
    const issue = await step('environment issue', () => postEnvIssue(ctx, github, items));
    if (issue) log(`environment issue: ${issue.html_url}`);
  }

  const bundle = { repo: ctx.repo, runId: ctx.runId, runUrl: ctx.runUrl, sha: ctx.sha, branch: ctx.branch, pr: ctx.pr?.number ?? null, generatedAt: new Date().toISOString(), items, fixes, fixPr: fixPr?.html_url ?? null };
  writeFileSync(join(ctx.outDir, 'triage.json'), JSON.stringify(bundle, null, 2), 'utf8');

  // LEARN: store this run (with its diagnoses) so the next run sees it as history.
  const diagnosed = imported.records.map((r) => ({ ...r, diagnosis: items.find((i) => i.runId === r.runId && i.testId === r.testId)?.diagnosis }));
  const runs = [...pastRuns, imported.summary].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-MAX_HISTORY_RUNS);
  const kept = new Set(runs.map((s) => s.runId));
  writeFileSync(history.runs, runs.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  writeFileSync(history.triage, [...pastRecords, ...diagnosed].filter((r) => kept.has(r.runId)).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const byCategory = [...new Set(items.map((i) => i.diagnosis.category))].map((c) => `${c} ${items.filter((i) => i.diagnosis.category === c).length}`);
  log(`${items.length} failing test(s): ${byCategory.join(', ') || 'none'}; LLM layer ${llm?.model ?? 'off'}; fixes accepted ${fixes.filter((f) => f.status === 'fixed').length}`);
}

try {
  await main();
} catch (error) {
  console.warn(`::warning::triage-agent could not finish: ${String(error).slice(0, 600)}`);
}
