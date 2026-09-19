// GitHub Action "report" mode (see action.yml): for scheduled runs, e.g. weekly. Builds the
// window views for senior / principal engineers, architects and leads from the run history in
// the Actions cache, reusing the diagnoses stored by earlier CI runs (no repeat AI calls), and
// keeps them in one GitHub issue that each report updates.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { buildItems } from '../outlets/items.ts';
import { architectureView } from '../outlets/views/architecture.ts';
import { digestView } from '../outlets/views/digest.ts';
import { qualityView } from '../outlets/views/quality.ts';
import { datasetFiles, readRunSummaries, readTriageRecords } from '../reporters/store.ts';
import { readCiContext } from './context.ts';
import { GitHub } from './github.ts';

export const REPORT_MARKER = '<!-- triage-agent:team-report -->';
const MAX_BODY = 60_000;

async function main(): Promise<void> {
  const ctx = readCiContext();
  mkdirSync(ctx.outDir, { recursive: true });
  const history = datasetFiles(ctx.historyDir);
  const records = readTriageRecords(history.triage);
  const summaries = readRunSummaries(history.runs);
  const label = `${ctx.repo} CI history (${summaries.length} runs)`;
  console.log(`[tewip] report over ${summaries.length} run(s) and ${records.length} failed attempt(s) from the cache`);

  const index = new HistoryIndex(records, summaries);
  const items = await buildItems(records, index, { dataset: label, llm: llmFromEnv(), reuseStoredDiagnoses: true });
  const views = [qualityView(items, label), architectureView(items, label), digestView(items, summaries, label)];
  for (const v of views) writeFileSync(join(ctx.outDir, `${v.id}.md`), v.markdown, 'utf8');

  const date = new Date().toISOString().slice(0, 10);
  const intro = [
    `## Tewip team report, ${date}`,
    '',
    `Built from ${summaries.length} CI run(s) on this branch. Sections: engineering quality (senior and principal engineers), architecture (architects), and risk digest (leads). Each report replaces the previous one in this issue; the history of edits keeps older reports.`,
    `<sub>[Report run](${ctx.runUrl})</sub>`,
  ].join('\n');
  const body = [intro, ...views.map((v) => v.markdown)].join('\n\n---\n\n');
  const fitted = body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY)}\n\n…truncated: the full report is in the \`tewip-report\` artifact.`;
  writeFileSync(join(ctx.outDir, 'team-report.md'), body, 'utf8');
  if (ctx.stepSummary) writeFileSync(ctx.stepSummary, fitted, { encoding: 'utf8', flag: 'a' });

  if (!ctx.token) return;
  const github = new GitHub(ctx.token, ctx.repo, ctx.apiUrl);
  const open = await github.request<Array<{ number: number; html_url: string; body: string | null; pull_request?: unknown }>>('GET', '/repos/{repo}/issues?state=open&per_page=100');
  const existing = open.find((i) => !i.pull_request && i.body?.includes(REPORT_MARKER));
  const text = `${REPORT_MARKER}\n${fitted}`;
  const issue = existing
    ? await github.request<{ html_url: string }>('PATCH', `/repos/{repo}/issues/${existing.number}`, { body: text })
    : await github.request<{ html_url: string }>('POST', '/repos/{repo}/issues', { title: 'Tewip: team report', body: text });
  console.log(`[tewip] team report: ${issue.html_url}`);
}

try {
  await main();
} catch (error) {
  console.warn(`::warning::tewip report could not finish: ${String(error).slice(0, 600)}`);
}
