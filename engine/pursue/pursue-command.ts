// `tewip pursue "<a goal>"`: what Tewip would do next about it, and why.
//
// By default it decides and explains, and does nothing. `--act` lets it carry out the one action
// it chose, and only through the gates that already prove a change before keeping it. There is no
// mode in which it loops unattended: an agent that keeps going until it decides to stop is the
// thing teams roll back, and nothing here needs it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { datasetFiles, readJsonl, readTriageRecords } from '../../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { decide, type Decision, type Observed } from './policy.ts';

export interface PursueCommand {
  root: string;
  goal: string;
  /** Carry out the chosen action, where carrying it out is safe and gated. */
  act?: boolean;
  name?: string;
  out?: string;
}

const words = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !['the', 'and', 'for', 'this', 'that', 'with', 'keep', 'green', 'sprint', 'flow', 'test', 'tests'].includes(w));

/** Does this test or scenario belong to the goal? Deterministic, so a person can predict it. */
function about(goal: string[], text: string): boolean {
  if (goal.length === 0) return true; // an unworded goal means the whole project
  const haystack = text.toLowerCase();
  return goal.some((w) => haystack.includes(w));
}

/** What is true about this project right now, as far as anything kept here can show. */
export function observe(root: string, goal: string, only?: string): Observed {
  const dir = join(root, '.tewip', 'history');
  const runs: RunSummary[] = [];
  const records: TriageRecord[] = [];
  if (existsSync(dir)) {
    for (const project of only ? [only] : readdirSync(dir)) {
      const where = join(dir, project);
      if (!existsSync(where)) continue;
      runs.push(...readJsonl<RunSummary>(datasetFiles(where).runs));
      records.push(...readTriageRecords(datasetFiles(where).triage));
    }
  }
  runs.sort((a, b) => (a.finishedAt > b.finishedAt ? 1 : -1));
  const newest = runs.at(-1);
  const wanted = words(goal);

  const failing = records
    .filter((r) => r.runId === newest?.runId && about(wanted, r.testId))
    .map((r) => {
      const d = r.diagnosis as { category?: string; confidence?: number } | undefined;
      return { testId: r.testId, category: String(d?.category ?? 'UNKNOWN'), confidence: Number(d?.confidence ?? 0) };
    });

  // A test that failed in more than one earlier run and is not failing now has come and gone.
  const failedBefore = new Map<string, number>();
  for (const r of records) if (about(wanted, r.testId)) failedBefore.set(r.testId, (failedBefore.get(r.testId) ?? 0) + 1);
  const failingNow = new Set(failing.map((f) => f.testId));
  const flaky = [...failedBefore.entries()].filter(([testId, times]) => times >= 2 && !failingNow.has(testId)).map(([testId, times]) => ({ testId, times }));

  const attempted = Object.keys(newest?.attempts ?? {}).filter((t) => about(wanted, t));
  return {
    failing,
    flaky,
    uncovered: uncoveredScenarios(root, wanted, attempted),
    passing: attempted.length - failing.length,
    noHistory: runs.length === 0,
  };
}

/** Scenarios of a kept plan that no attempted test can be matched to, worst priority first. */
function uncoveredScenarios(root: string, goal: string[], attempted: string[]): Observed['uncovered'] {
  const dir = join(root, '.tewip', 'plans');
  if (!existsSync(dir)) return [];
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out: Observed['uncovered'] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const saved = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { plan?: { title?: string; scenarios?: Array<Record<string, string>> }; feature?: string };
      const plan = saved.plan ?? (saved as never);
      if (!Array.isArray(plan.scenarios)) continue;
      if (!about(goal, `${plan.title ?? ''} ${saved.feature ?? ''}`)) continue;
      for (const scenario of plan.scenarios) {
        const covered = (scenario.covered_by ?? '').trim() || attempted.find((t) => clean(t).includes(clean(scenario.id)) && clean(scenario.id).length >= 4);
        if (!covered) out.push({ id: scenario.id, title: scenario.title, priority: scenario.priority ?? '' });
      }
    } catch {
      // Not a readable plan.
    }
  }
  return out.sort((a, b) => (a.priority || 'P9').localeCompare(b.priority || 'P9'));
}

export function renderPursuit(goal: string, seen: Observed, decision: Decision, acting: boolean): string {
  const lines = [
    `# Goal: ${goal}`,
    '',
    `What is true now: ${seen.passing} passing, ${seen.failing.length} failing, ${seen.flaky.length} that come and go, ${seen.uncovered.length} unchecked.`,
    '',
    '## What Tewip would do next',
    '',
    `**${decision.next}**`,
    '',
    decision.why + '.',
    '',
  ];
  if (decision.evidence.length > 0) {
    lines.push('What it is reacting to:', '');
    for (const e of decision.evidence) lines.push(`- ${e}`);
    lines.push('');
  }
  lines.push(
    decision.changesFiles
      ? acting
        ? 'This changes files, so it runs through the gate that proves a change before keeping it: anything unproved is thrown away.'
        : 'This would change files, so Tewip has not done it. Run the command it names, or pass `--act`.'
      : 'Tewip has not done anything: this is a decision, and the action is yours.',
    '',
    'The order of these decisions is fixed and written down, not chosen by a model: a real bug first,',
    'then the environment, then flakiness, then a coverage gap, and only then is a goal worth attesting.',
  );
  return lines.join('\n');
}

export function runPursue(cmd: PursueCommand): { decision: Decision; observed: Observed } {
  const observed = observe(cmd.root, cmd.goal, cmd.name);
  const decision = decide(cmd.goal, observed);
  const report = renderPursuit(cmd.goal, observed, decision, Boolean(cmd.act));
  console.log(report);
  if (cmd.act && decision.changesFiles) {
    console.error('\n`--act` is accepted, but Tewip carries out a change only through the command that proves it.');
    console.error(`Run: ${decision.next}`);
  }
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  return { decision, observed };
}
