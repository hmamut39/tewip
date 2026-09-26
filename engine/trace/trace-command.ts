// `tewip trace`: is this requirement covered, and is it passing right now?
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { datasetFiles, readJsonl, readTriageRecords } from '../../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { renderTrace, tracePlan, type PlanFile, type TracedRequirement } from './trace.ts';

export interface TraceCommand {
  root: string;
  /** Only the plan whose title or ticket contains this. */
  only?: string;
  name?: string;
  out?: string;
}

/** The plans this project has kept, as `tewip plan` saved them. */
function plans(root: string, only?: string): PlanFile[] {
  const dir = join(root, '.tewip', 'plans');
  if (!existsSync(dir)) return [];
  const out: PlanFile[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      // `tewip plan` saves { plan, feature, urls, model }: the scenarios live under `plan`, and the
      // feature - the words someone actually asked for - sits beside it. Reading the top level
      // alone found no plans at all in a project that had one.
      const saved = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { plan?: PlanFile; feature?: string; ticket?: string } & PlanFile;
      const inner = saved.plan ?? saved;
      if (!Array.isArray(inner?.scenarios)) continue;
      const parsed: PlanFile = { ...inner, feature: saved.feature ?? inner.feature, ticket: saved.ticket ?? inner.ticket };
      const haystack = `${parsed.title ?? ''} ${parsed.feature ?? ''} ${parsed.ticket ?? ''} ${file}`.toLowerCase();
      if (only && !haystack.includes(only.toLowerCase())) continue;
      out.push(parsed);
    } catch {
      // A plan that is not readable JSON is not a plan; the Markdown beside it is still there.
    }
  }
  return out;
}

function history(root: string, only?: string): { runs: RunSummary[]; records: TriageRecord[] } {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return { runs: [], records: [] };
  const runs: RunSummary[] = [];
  const records: TriageRecord[] = [];
  for (const project of only ? [only] : readdirSync(dir)) {
    const where = join(dir, project);
    if (!existsSync(where)) continue;
    runs.push(...readJsonl<RunSummary>(datasetFiles(where).runs));
    records.push(...readTriageRecords(datasetFiles(where).triage));
  }
  runs.sort((a, b) => (a.finishedAt > b.finishedAt ? 1 : -1));
  return { runs, records };
}

export function runTrace(cmd: TraceCommand): TracedRequirement[] {
  const found = plans(cmd.root, cmd.only);
  const { runs, records } = history(cmd.root, cmd.name);
  const traced = found.map((plan) => tracePlan(plan, runs, records));
  const report = renderTrace(traced);
  console.log(report);
  if (found.length > 0) {
    console.error(`\nTraced ${found.length} plan(s) against ${runs.length} kept run(s). No model was called.`);
  }
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  return traced;
}
