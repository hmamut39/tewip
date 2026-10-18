// `tewip pursue "<a goal>"`: what Tewip would do next about it, and why.
//
// By default it decides and explains, and does nothing. `--act` lets it carry out the one action
// it chose, and only through the gates that already prove a change before keeping it. There is no
// mode in which it loops unattended: an agent that keeps going until it decides to stop is the
// thing teams roll back, and nothing here needs it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { datasetFiles, readJsonl, readTriageRecords } from '../../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { alreadyTried, cannotAct, planFor, type ActionRecord } from './act.ts';
import { decide, type Decision, type Observed } from './policy.ts';
import { CANNOT_FAIL } from '../vouch/vouch.ts';
import { applyCorrection, correctionFor, loadCorrections, type Correction } from '../corrections.ts';
import { vouchAll } from '../vouch/vouch-command.ts';

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
  const corrections: Correction[] = [];
  if (existsSync(dir)) {
    for (const project of only ? [only] : readdirSync(dir)) {
      const where = join(dir, project);
      if (!existsSync(where)) continue;
      runs.push(...readJsonl<RunSummary>(datasetFiles(where).runs));
      records.push(...readTriageRecords(datasetFiles(where).triage));
      corrections.push(...loadCorrections(where));
    }
  }
  runs.sort((a, b) => (a.finishedAt > b.finishedAt ? 1 : -1));
  const newest = runs.at(-1);
  const wanted = words(goal);

  // A person's correction decides the category, as it does everywhere else.
  //
  // This read `r.diagnosis` straight off the record, so a correction never reached the decision.
  // Field-tested: a person marked a failure REAL_BUG, and `pursue` went on calling it LOCATOR_DRIFT
  // and concluding "the goal is failing and Tewip cannot say why". That matters more here than in a
  // report, because this is the command that **acts** - and its own documented order is "a real bug
  // first... it will not touch a real bug", a safety rule that depends on recognising one. The
  // strongest possible signal that something is a real bug is a person saying so.
  //
  // Phase 74 fixed this inside `buildItems` for every command that goes through it. This one does
  // not, so it applies them itself.
  const failing = records
    .filter((r) => r.runId === newest?.runId && about(wanted, r.testId))
    .map((r) => {
      const correction = corrections.length > 0 ? correctionFor(r, corrections) : null;
      const own = r.diagnosis as { category?: string; confidence?: number } | undefined;
      const d = correction && own ? applyCorrection(own as never, correction) : own;
      return {
        testId: r.testId,
        category: String((correction?.category ?? d?.category) ?? 'UNKNOWN'),
        confidence: Number(d?.confidence ?? (correction ? 1 : 0)),
      };
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
    runId: newest?.runId ?? '',
    vacuous: vacuousTests(root, wanted),
  };
}

/**
 * Tests covering this goal that could never fail, read from the files themselves.
 *
 * Only the verdicts that mean a test truly cannot fail are collected. A test that compares no value
 * is left out here on purpose: it fails when the code throws, it is often meant to, and stopping an
 * agent's whole goal over one would make this branch something people route around.
 */
function vacuousTests(root: string, goal: string[]): Observed['vacuous'] {
  try {
    const found = vouchAll(root, ['.']);
    return found
      .flatMap((file) => file.judgements)
      .filter((j) => CANNOT_FAIL.includes(j.verdict) && about(goal, `${j.file} ${j.name}`))
      .map((j) => ({ name: j.name, file: j.file, line: j.line, why: j.why }));
  } catch {
    return []; // an unreadable tree is not a tree full of worthless tests
  }
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
    'then the environment, then flakiness, then anything failing it cannot explain, then a test that',
    'cannot fail, then a coverage gap, and only then is a goal worth attesting.',
  );
  return lines.join('\n');
}

/** The audit file the team owns: every action Tewip took on its own, and every one it refused. */
const auditPath = (root: string) => join(root, '.tewip', 'actions.jsonl');

export function actionsTaken(root: string): ActionRecord[] {
  try {
    return readFileSync(auditPath(root), 'utf8')
      .split(String.fromCharCode(10))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ActionRecord);
  } catch {
    return [];
  }
}

function record(root: string, entry: ActionRecord): void {
  mkdirSync(dirname(auditPath(root)), { recursive: true });
  appendFileSync(auditPath(root), JSON.stringify(entry) + String.fromCharCode(10), 'utf8');
}

/**
 * The Tewip command line belonging to *this* build, found from this file rather than from how the
 * process was started.
 *
 * This is not a detail. The first version used process.argv[1], which is the command line only when
 * a person typed it: under a test runner argv[1] is the test file, so acting re-ran the test file,
 * which acted again, which re-ran it - a fork bomb that froze the machine it was written on. What
 * re-enters Tewip has to be Tewip, established here, or nothing is carried out at all.
 */
export function cliEntry(): string | null {
  const here = import.meta.dirname;
  for (const candidate of [join(here, '..', '..', 'cli', 'tewip.ts'), join(here, '..', '..', 'cli', 'tewip.js')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Carries out the one action that was decided, by running the command that already proves it.
 * Tewip does not do the work here; it asks the gate to.
 */
function carryOut(cmd: PursueCommand, decision: Decision, observed: Observed): string {
  const plan = planFor(decision);
  const runId = observed.runId ?? '';
  const note = (outcome: ActionRecord['outcome'], detail: string, target = plan?.target ?? ''): ActionRecord => ({
    at: new Date().toISOString(),
    goal: cmd.goal,
    act: decision.act,
    target,
    command: plan ? 'tewip ' + plan.command.join(' ') : '',
    runId,
    outcome,
    detail,
  });

  if (!plan) {
    const why = cannotAct[decision.act] || 'this is not something Tewip carries out on its own';
    record(cmd.root, note('refused', why, decision.act));
    return 'Not carried out: ' + why + '.';
  }

  const tried = alreadyTried(actionsTaken(cmd.root), decision.act, plan.target, runId);
  if (tried) {
    record(cmd.root, note('refused', 'already attempted at ' + tried.at + ', on the same evidence'));
    return ['Not carried out: Tewip already attempted this at ' + tried.at.slice(0, 19).replace('T', ' ') + ' UTC, and nothing has happened since that would make the outcome different.', '', 'That attempt ' + (tried.outcome === 'done' ? 'succeeded' : 'did not finish') + ': ' + tried.detail, '', 'Run ' + tried.command + ' yourself if you want it tried again.'].join(String.fromCharCode(10));
  }

  // Re-enter this same build, so an installed Tewip runs the installed gates and a checkout runs
  // the checkout's - never a different version from the one that decided, and never whatever
  // happens to have started this process.
  const entry = cliEntry();
  if (!entry) {
    record(cmd.root, note('refused', 'the Tewip command line could not be found next to this build, so there is nothing safe to re-enter'));
    return 'Not carried out: Tewip could not find its own command line beside this build, and it will not guess at one. Run ' + 'tewip ' + plan.command.join(' ') + ' yourself.';
  }
  const ran = spawnSync(process.execPath, [entry, ...plan.command], { cwd: cmd.root, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  const output = ((ran.stdout ?? '') + (ran.stderr ?? '')).trim();
  const ok = ran.status === 0;
  // What the audit file remembers: the headline of a success, the tail of a failure. A failure's
  // reason is at the end of what it printed; a success's is at the start.
  const lines = output.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  const detail = (ok ? lines[0] ?? 'it printed nothing' : lines.slice(-3).join(' ')).slice(0, 300);
  record(cmd.root, note(ok ? 'done' : 'failed', detail));
  return [
    ok ? 'Carried out: tewip ' + plan.command.join(' ') : 'Tried and did not finish: tewip ' + plan.command.join(' '),
    '',
    output.slice(-2000),
    '',
    ok
      ? 'Anything kept by that command was proved by it; anything unproved was thrown away. Written to .tewip/actions.jsonl.'
      : 'Nothing was kept. Written to .tewip/actions.jsonl.',
  ].join(String.fromCharCode(10));
}

export function runPursue(cmd: PursueCommand): { decision: Decision; observed: Observed } {
  const observed = observe(cmd.root, cmd.goal, cmd.name);
  const decision = decide(cmd.goal, observed);
  const report = renderPursuit(cmd.goal, observed, decision, Boolean(cmd.act));
  console.log(report);
  if (cmd.act) console.log(String.fromCharCode(10) + '---' + String.fromCharCode(10) + carryOut(cmd, decision, observed));
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  return { decision, observed };
}
