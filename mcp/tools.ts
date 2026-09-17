// What the MCP server answers. Each function returns markdown built by the same engine and
// role views as the CLI and the GitHub Action (one engine, many outlets). Read-only.
import { loadCorrections } from '../engine/corrections.ts';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lastFailedAttempts, loadDataset, type Dataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { historyPattern } from '../engine/llm/context.ts';
import { buildItems, type TriageItem } from '../outlets/items.ts';
import { clean, itemBlock, PLAIN_CATEGORY } from '../outlets/view.ts';
import { architectureView } from '../outlets/views/architecture.ts';
import { prCommentView } from '../outlets/views/developer.ts';
import { digestView } from '../outlets/views/digest.ts';
import { infraView } from '../outlets/views/infra.ts';
import { qualityView } from '../outlets/views/quality.ts';
import { releaseView } from '../outlets/views/release.ts';
import { sdetBoardView } from '../outlets/views/sdet.ts';
import { DATA_DIR, PROJECT_ROOT } from '../reporters/store.ts';

/** Keeps answers small enough for an assistant's context window. */
const MAX_CHARS = 40_000;
export const cap = (s: string) => (s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS)}\n\n…truncated (${s.length} characters in total).`);

const label = (dir: string) => relative(PROJECT_ROOT, dir).replaceAll('\\', '/') || '.';

/** Every directory holding collected failures: data/, data/lab, data/real/*. */
export function listDatasets(): string {
  const dirs = [DATA_DIR, join(DATA_DIR, 'lab'), ...(existsSync(join(DATA_DIR, 'real')) ? readdirSync(join(DATA_DIR, 'real')).map((d) => join(DATA_DIR, 'real', d)) : [])];
  const rows = dirs
    .filter((d) => existsSync(join(d, 'triage.jsonl')))
    .map((d) => {
      const ds = loadDataset(d);
      const latest = ds.summaries.map((s) => s.startedAt).sort().at(-1)?.slice(0, 10) ?? '-';
      return `- \`${label(d)}\`: ${ds.records.length} failed attempts in ${ds.summaries.length} runs, latest ${latest}`;
    });
  return rows.length ? `# Datasets\n\n${rows.join('\n')}` : 'No collected failures yet. Run Playwright with the triage reporter, or harvest real CI data (see eval/README.md).';
}

function open(dir?: string): { dataset: Dataset; index: HistoryIndex } {
  const dataset = loadDataset(dir ? join(PROJECT_ROOT, dir) : undefined);
  if (dataset.records.length === 0) throw new Error(`No failure records in ${dataset.label}. Call list_datasets to see what is available.`);
  return { dataset, index: new HistoryIndex(dataset.records, dataset.summaries) };
}

const failedRuns = (dataset: Dataset) =>
  dataset.summaries.filter((s) => dataset.records.some((r) => r.runId === s.runId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

function resolveRun(dataset: Dataset, run?: string): string {
  const runs = failedRuns(dataset);
  if (!run) {
    if (!runs[0]) throw new Error('No run with failures in this dataset.');
    return runs[0].runId;
  }
  const matches = runs.filter((s) => s.runId.includes(run));
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `No failed run matches "${run}".` : `"${run}" matches ${matches.length} runs; be more specific.`);
  return matches[0].runId;
}

const memo = new Map<string, Promise<TriageItem[]>>();
function itemsFor(dir: string | undefined, dataset: Dataset, index: HistoryIndex, runId: string | null, ai: boolean): Promise<TriageItem[]> {
  const key = `${dir ?? ''}|${runId ?? '*'}|${ai}`;
  if (!memo.has(key)) {
    const records = runId ? dataset.records.filter((r) => r.runId === runId) : dataset.records;
    // Corrections people made are part of what the agent knows, so an assistant asking "why did
    // CI fail?" is told the answer a person settled, not the one the agent had first.
    const corrections = loadCorrections(dir ?? DATA_DIR);
    memo.set(key, buildItems(records, index, { dataset: dataset.label, llm: ai ? llmFromEnv() : null, corrections }));
  }
  return memo.get(key)!;
}

export function listFailedRuns(dir?: string, limit = 15): string {
  const { dataset } = open(dir);
  const rows = failedRuns(dataset)
    .slice(0, limit)
    .map((s) => {
      const failed = new Set(dataset.records.filter((r) => r.runId === s.runId).map((r) => r.testId)).size;
      return `| ${s.runId} | ${s.startedAt.slice(0, 16).replace('T', ' ')} | ${s.branch || '-'} | ${failed} |`;
    });
  return `# Latest runs with failures in \`${dataset.label}\`\n\n| Run | Started (UTC) | Branch | Failing tests |\n|---|---|---|---:|\n${rows.join('\n')}`;
}

export type RunView = 'sdet' | 'developer' | 'environment' | 'release';

export async function runView(view: RunView, dir?: string, run?: string, ai = true): Promise<string> {
  const { dataset, index } = open(dir);
  const runId = resolveRun(dataset, run);
  const items = await itemsFor(dir, dataset, index, runId, ai);
  const render = { sdet: sdetBoardView, developer: prCommentView, environment: infraView, release: releaseView }[view];
  return cap(render(items, runId, dataset.label).markdown);
}

export type WindowView = 'quality' | 'architecture' | 'digest';

export async function windowView(view: WindowView, dir?: string, ai = true): Promise<string> {
  const { dataset, index } = open(dir);
  const items = await itemsFor(dir, dataset, index, null, ai);
  if (view === 'digest') return cap(digestView(items, dataset.summaries, dataset.label).markdown);
  return cap((view === 'quality' ? qualityView : architectureView)(items, dataset.label).markdown);
}

/** Everything the agent knows about one failing test: diagnosis, evidence, history, next action. */
export async function explainFailure(test: string, dir?: string, run?: string, ai = true): Promise<string> {
  const { dataset, index } = open(dir);
  const needle = test.toLowerCase();
  const candidates = lastFailedAttempts(dataset.records).filter((r) => r.testId.toLowerCase().includes(needle) && (!run || r.runId.includes(run)));
  if (candidates.length === 0) return `No failed test matching "${test}" in \`${dataset.label}\`${run ? ` run ${run}` : ''}.`;
  const latest = candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const distinctTests = [...new Set(latest.map((r) => r.testId))];
  if (distinctTests.length > 1) return `"${test}" matches ${distinctTests.length} tests; be more specific:\n\n${distinctTests.slice(0, 20).map((t) => `- ${clean(t)}`).join('\n')}`;

  const record = latest[0];
  const [item] = await itemsFor(dir, dataset, index, record.runId, ai).then((xs) => xs.filter((i) => i.testId === record.testId));
  const failedIn = new Set(latest.map((r) => r.runId)).size;
  return cap(
    [
      `# ${clean(item.title)}`,
      '',
      itemBlock(item),
      '',
      `**In plain words:** ${PLAIN_CATEGORY[item.diagnosis.category]}.`,
      `**Why this action:** ${item.action.reason}.`,
      `**Related to the change that triggered the run?** ${item.relation.verdict}: ${item.relation.why}.`,
      `**History:** ${historyPattern(index.historyAsOf(record.testId, record.runId))}. Failed in ${failedIn} run(s) of this dataset.`,
      item.debt.length ? `**Test-design debt near the failing line:** ${item.debt.map((d) => `${d.kind} (${clean(d.detail)})`).join('; ')}` : '',
      '',
      '## Full evidence',
      ...item.diagnosis.evidence.map((e) => `- [${e.source}] ${clean(e.message)}`),
      '',
      '## Error',
      '```',
      record.errorMessage.slice(0, 3000),
      '```',
    ].join('\n'),
  );
}
