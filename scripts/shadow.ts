// Shadow run: what triage-agent would have said on a public project's real CI, without posting
// anything there. Renders, for every failed run in a harvested dataset, the PR comment the agent
// would have written, plus a summary, and (with --publish <owner/repo>) posts it as one issue with
// one comment per run in a repository you own. References to the public project are written in
// code formatting so GitHub creates no "mentioned in" links on it.
// Usage: node scripts/shadow.ts <source> [--dataset name] [--publish owner/repo] [--max-runs 25]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghRaw } from '../eval/harvest/gh.ts';
import { metaFile, SOURCES, type RunMeta } from '../eval/harvest/harvest.ts';
import { GitHub } from '../ci/github.ts';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { buildItems, type TriageItem } from '../outlets/items.ts';
import { prCommentView } from '../outlets/views/developer.ts';
import { groupEnv } from '../outlets/views/infra.ts';
import { DATA_DIR, readJsonl } from '../reporters/store.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const count = (xs: TriageItem[], f: (i: TriageItem) => boolean) => xs.filter(f).length;

function runLine(meta: RunMeta, repo: string, items: TriageItem[]): string {
  const where = meta.prNumbers.length ? `\`${repo}#${meta.prNumbers[0]}\`` : `\`${meta.branch}\``;
  const categories = [...new Set(items.map((i) => i.diagnosis.category))].map((c) => `${c} ${count(items, (i) => i.diagnosis.category === c)}`).join(', ');
  return `| \`${meta.githubRunId}\` | ${meta.createdAt.slice(0, 16).replace('T', ' ')} | ${where} | ${items.length} | ${count(items, (i) => i.relation.verdict === 'likely-this-change')} | ${count(items, (i) => i.relation.verdict === 'not-this-change')} | ${categories} |`;
}

async function main(): Promise<void> {
  const source = process.argv[2];
  const config = SOURCES[source];
  if (!config) throw new Error(`usage: shadow.ts <${Object.keys(SOURCES).join('|')}> [--dataset name] [--publish owner/repo]`);
  const dataset = arg('dataset') ?? source;
  const maxRuns = Number(arg('max-runs') ?? 25);

  const data = loadDataset(`data/real/${dataset}`);
  const metas = new Map(readJsonl<RunMeta>(metaFile(dataset)).filter((m) => m.imported).map((m) => [m.runId, m]));
  const index = new HistoryIndex(data.records, data.summaries);
  const items = await buildItems(data.records, index, { dataset: `${config.repo} CI (shadow run)`, llm: llmFromEnv() });

  const failedRuns = data.summaries
    .filter((s) => s.status !== 'passed' && items.some((i) => i.runId === s.runId) && metas.has(s.runId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const runItems = (runId: string) => items.filter((i) => i.runId === runId);
  const days = data.summaries.map((s) => s.startedAt.slice(0, 10)).sort();
  const envGroups = groupEnv(items.filter((i) => failedRuns.some((r) => r.runId === i.runId)));
  const inFailed = items.filter((i) => failedRuns.some((r) => r.runId === i.runId));

  const summary = [
    `## Shadow run: triage-agent on \`${config.repo}\` (${config.workflow}), ${days[0]} to ${days.at(-1)}`,
    '',
    `> **Nothing was posted to \`${config.repo}\`.** This is what triage-agent would have said on its real CI, rebuilt from the public blob reports. Every diagnosis shows its confidence and source.`,
    '',
    `- Runs analysed: **${data.summaries.length}**, of which **${failedRuns.length} failed** with **${inFailed.length} failing test case(s)**.`,
    `- By category: ${[...new Set(inFailed.map((i) => i.diagnosis.category))].map((c) => `${c} ${count(inFailed, (i) => i.diagnosis.category === c)}`).join(', ')}.`,
    `- For developers: ${count(inFailed, (i) => i.relation.verdict === 'likely-this-change')} likely caused by the PR's change, ${count(inFailed, (i) => i.relation.verdict === 'not-this-change')} probably not, ${count(inFailed, (i) => i.relation.verdict === 'unclear')} unclear.`,
    `- For DevOps: ${envGroups.length} environment problem group(s)${envGroups.length ? `, largest: ${envGroups[0].signature} (${envGroups[0].items.length} failures)` : ''}.`,
    `- Actions the agent could take on its own: ${count(inFailed, (i) => i.action.autonomous)} of ${inFailed.length}; the rest go to a person.`,
    '',
    '| Run | Started (UTC) | PR / branch | Failing tests | Likely this change | Probably not | Categories |',
    '|---|---|---|---:|---:|---:|---|',
    ...failedRuns.slice(0, maxRuns).map((s) => runLine(metas.get(s.runId)!, config.repo, runItems(s.runId))),
    '',
    `The comments below show the PR comment the agent would have posted for each of the ${Math.min(maxRuns, failedRuns.length)} most recent failed runs.`,
  ].join('\n');

  const comments = failedRuns.slice(0, maxRuns).map((s) => {
    const meta = metas.get(s.runId)!;
    const where = meta.prNumbers.length ? `PR \`${config.repo}#${meta.prNumbers[0]}\`` : `branch \`${meta.branch}\``;
    const body = prCommentView(runItems(s.runId), s.runId, `${config.repo} CI (shadow run)`).markdown.replaceAll('https://github.com/', 'github.com/');
    return `### Would have been posted on ${where}, run \`${meta.githubRunId}\`\n\n${body}`.slice(0, 60_000);
  });

  const out = join(DATA_DIR, 'reports', `shadow-${dataset}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'summary.md'), summary, 'utf8');
  writeFileSync(join(out, 'comments.md'), comments.join('\n\n---\n\n'), 'utf8');
  console.log(summary);

  const target = arg('publish');
  if (!target) return;
  const github = new GitHub((await ghRaw(['auth', 'token'])).toString('utf8').trim(), target);
  const issue = await github.request<{ number: number; html_url: string }>('POST', '/repos/{repo}/issues', { title: `Shadow run: triage-agent on ${config.repo} (${days[0]} to ${days.at(-1)})`, body: summary });
  for (const c of comments) await github.request('POST', `/repos/{repo}/issues/${issue.number}/comments`, { body: c });
  console.log(`\npublished: ${issue.html_url}`);
}

if (import.meta.main) await main();
