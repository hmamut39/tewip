// Renders every role's view for a dataset and prints the phase-4 metric.
// Run-level views (PR comment, SDET board, infrastructure, release readiness) are written for
// each failed CI run, window views (engineering quality, architecture, risk digest) once, as
// markdown under data/reports/ (gitignored: they contain collected failure data).
// Metric: share of failures that appear, complete (confidence, source, next action, evidence),
// in every view their category is routed to.
// Usage: node scripts/triage.ts [--data <dataset dir>] [--run <runId>] [--no-llm] [--out <dir>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { usageLine } from '../engine/llm/usage.ts';
import { buildItems, type TriageItem } from '../outlets/items.ts';
import { missingFromView, ROUTES, type View } from '../outlets/view.ts';
import { architectureView } from '../outlets/views/architecture.ts';
import { prCommentView } from '../outlets/views/developer.ts';
import { digestView } from '../outlets/views/digest.ts';
import { infraView } from '../outlets/views/infra.ts';
import { qualityView } from '../outlets/views/quality.ts';
import { releaseView } from '../outlets/views/release.ts';
import { sdetBoardView } from '../outlets/views/sdet.ts';
import { DATA_DIR, PROJECT_ROOT } from '../reporters/store.ts';

const METRIC_TARGET = 0.9;
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function runViews(items: TriageItem[], runId: string, dataset: string): View[] {
  return [prCommentView(items, runId, dataset), sdetBoardView(items, runId, dataset), infraView(items, runId, dataset), releaseView(items, runId, dataset)];
}

/** Why an item fails the phase-4 metric, or null: it must be complete in every view its category routes to. */
function routingProblem(item: TriageItem, views: View[]): string | null {
  for (const role of ROUTES[item.diagnosis.category]) {
    const view = views.find((v) => v.role === role);
    if (!view) return `no ${role} view`;
    const problem = missingFromView(view, item);
    if (problem) return problem;
  }
  return null;
}

async function main(): Promise<void> {
  const dataDir = arg('data');
  const dataset = loadDataset(dataDir);
  if (dataset.records.length === 0) {
    console.log(`No failure records in ${dataset.label}.`);
    return;
  }
  const outDir = arg('out') ?? join(DATA_DIR, 'reports', basename(dataDir ?? 'local'));
  const index = new HistoryIndex(dataset.records, dataset.summaries);
  const llm = process.argv.includes('--no-llm') ? null : llmFromEnv();
  console.log(`Dataset ${dataset.label}: ${dataset.records.length} failure records, ${dataset.summaries.length} runs. LLM layer: ${llm?.model ?? 'off'}`);

  // No corrections, on purpose: this measures the engine against known answers. See scripts/shadow.ts.
  const items = await buildItems(dataset.records, index, { dataset: dataset.label, llm });
  const failedRuns = dataset.summaries.filter((s) => s.status !== 'passed' && items.some((i) => i.runId === s.runId)).map((s) => s.runId);
  const runs = arg('run') ? [arg('run')!] : failedRuns;

  let routed = 0;
  let total = 0;
  const problems: string[] = [];
  for (const runId of runs) {
    const runItems = items.filter((i) => i.runId === runId);
    const views = runViews(runItems, runId, dataset.label);
    for (const v of views) {
      mkdirSync(join(outDir, 'runs', runId), { recursive: true });
      writeFileSync(join(outDir, 'runs', runId, `${v.id}.md`), v.markdown, 'utf8');
    }
    for (const item of runItems) {
      total++;
      const problem = routingProblem(item, views);
      if (problem) problems.push(`${runId} ${item.testId}: ${problem}`);
      else routed++;
    }
  }

  const windowViews = [qualityView(items, dataset.label), architectureView(items, dataset.label), digestView(items, dataset.summaries, dataset.label)];
  for (const v of windowViews) {
    writeFileSync(join(outDir, `${v.id}.md`), v.markdown, 'utf8');
    for (const item of v.items) {
      const problem = missingFromView(v, item);
      if (problem) problems.push(`${v.id} ${item.testId}: ${problem}`);
    }
  }

  const byCategory = [...new Set(items.map((i) => i.diagnosis.category))].map((c) => `${c} ${items.filter((i) => i.diagnosis.category === c).length}`);
  const autonomous = items.filter((i) => i.action.autonomous).length;
  console.log(`\n${items.length} failing test case(s) in ${failedRuns.length} failed run(s). By category: ${byCategory.join(', ')}`);
  console.log(`Planned actions the agent may take on its own (once automated): ${autonomous}/${items.length}; the rest need a person.`);
  console.log(`Views written to ${relative(PROJECT_ROOT, outDir)} (${runs.length} run(s) x 4 run views, plus quality / architecture / digest).`);
  const ratio = total === 0 ? 0 : routed / total;
  console.log(
    `\nPhase 4 metric, over ${runs.length} failed run(s) of ${dataset.label}: ${routed}/${total} = ${(ratio * 100).toFixed(1)}% of failures ` +
      `reach every view their category routes to, complete (target >= ${METRIC_TARGET * 100}%: ${ratio >= METRIC_TARGET ? 'MET' : 'MISSED'})`,
  );
  console.log(usageLine());
  console.log(`Diagnoses shown without confidence, source, action or evidence: ${problems.length}`);
  for (const p of problems.slice(0, 10)) console.log(`  - ${p}`);
}

if (import.meta.main) await main();
