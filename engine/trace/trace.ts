// Phase 18: the thread from what someone asked for to what is passing right now.
//
// Every piece of this already exists and none of it is joined. A specification says what should
// happen. A plan turns that into scenarios. `write` turns scenarios into tests. Runs say which
// tests were attempted and which failed, and a diagnosis says why. Nobody can follow that chain,
// so the question an executive actually asks - *is this requirement covered, and is it passing?* -
// has no answer, and the honest parts of Tewip are invisible to the person paying for it.
//
// What this file refuses to do is the thing that would make the report look best: guess. A
// scenario is "covered" only when a real test can be named. It is "passing" only when a real run
// attempted it and did not record a failure. Anything else says what is missing instead, because a
// green thread that was inferred is worse than no thread - it is a claim nobody checked.
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';

export type Standing =
  | 'passing' // a real run attempted it and recorded no failure
  | 'failing' // a real run recorded a failure, and Tewip says why
  | 'never-run' // a test exists, but no run kept here has attempted it
  | 'not-covered'; // no test can be named for it

export interface TracedScenario {
  id: string;
  title: string;
  priority: string;
  standing: Standing;
  /** The test that covers it, when one can be named. */
  test: string;
  /** The run that is being quoted, so the standing can be checked. */
  runId: string;
  when: string;
  /** For a failure: what Tewip decided, and how sure. */
  diagnosis: string;
  /** One line a person can act on. */
  why: string;
}

export interface TracedRequirement {
  /** What was asked for: a plan's title, or the ticket it was built from. */
  requirement: string;
  /** The ticket, when the plan came from one. */
  ticket: string;
  scenarios: TracedScenario[];
}

export interface PlanFile {
  title: string;
  feature?: string;
  ticket?: string;
  scenarios: Array<{ id: string; title: string; priority?: string; covered_by?: string; automate?: boolean }>;
}

const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The test that covers a scenario, named from evidence rather than hope.
 *
 * Two ways a link is real: the plan says which existing test covers it - and that claim was already
 * checked against the project's real test names when the plan was written - or a test file carries
 * the scenario's own id, which is how `tewip write` names what it creates.
 */
export function testFor(scenario: PlanFile['scenarios'][number], attempted: string[]): string {
  const claim = (scenario.covered_by ?? '').trim();
  if (claim) {
    const exact = attempted.find((t) => t === claim);
    if (exact) return exact;
    // A plan names a test as a person writes it; a report names it as the runner prints it.
    const loose = attempted.find((t) => clean(t).includes(clean(claim.split(':')[0])) && clean(claim.split(':')[0]).length > 6);
    if (loose) return loose;
    return claim; // named, but this project has not attempted it in any kept run
  }
  const id = clean(scenario.id);
  return id.length >= 4 ? (attempted.find((t) => clean(t).includes(id)) ?? '') : '';
}

/** Joins one plan to what the runs actually say. Nothing here is inferred from anything else. */
export function tracePlan(plan: PlanFile, runs: RunSummary[], records: TriageRecord[]): TracedRequirement {
  const newest = runs.at(-1);
  const attempted = newest ? Object.keys(newest.attempts ?? {}) : [];
  const everAttempted = new Set(runs.flatMap((r) => Object.keys(r.attempts ?? {})));
  const failures = new Map<string, TriageRecord>();
  for (const record of records) if (record.runId === newest?.runId) failures.set(record.testId, record);

  const scenarios = plan.scenarios.map((scenario): TracedScenario => {
    const test = testFor(scenario, attempted);
    const base = { id: scenario.id, title: scenario.title, priority: scenario.priority ?? '', test, runId: newest?.runId ?? '', when: newest?.finishedAt ?? '' };
    if (!test) {
      return { ...base, standing: 'not-covered', diagnosis: '', why: 'no test in this project can be named for it, so nothing is checking it' };
    }
    if (!everAttempted.has(test)) {
      return { ...base, standing: 'never-run', runId: '', when: '', diagnosis: '', why: `${test} is named as the cover, but no run kept here has attempted it` };
    }
    const failed = failures.get(test);
    if (failed) {
      const d = failed.diagnosis as { category?: string; confidence?: number; source?: string } | undefined;
      const diagnosis = d?.category ? `${d.category} at ${Number(d.confidence ?? 0).toFixed(2)} (${d.source ?? 'unknown'})` : 'failed, undiagnosed';
      return { ...base, standing: 'failing', diagnosis, why: `${test} failed in the last run, and Tewip calls it ${d?.category ?? 'undiagnosed'}` };
    }
    if (!attempted.includes(test)) {
      return { ...base, standing: 'never-run', diagnosis: '', why: `${test} ran before but not in the last run, so its standing now is unknown` };
    }
    return { ...base, standing: 'passing', diagnosis: '', why: `${test} was attempted in the last run and recorded no failure` };
  });

  return { requirement: plan.title || plan.feature || 'an unnamed requirement', ticket: plan.ticket ?? '', scenarios };
}

const MARK: Record<Standing, string> = { passing: 'passing', failing: 'FAILING', 'never-run': 'never run', 'not-covered': 'NOT COVERED' };

/** The answer to "is this covered, and is it passing", written so it can be disagreed with. */
export function renderTrace(traced: TracedRequirement[]): string {
  const all = traced.flatMap((t) => t.scenarios);
  const count = (s: Standing) => all.filter((x) => x.standing === s).length;
  const lines = ['# From what was asked for, to what is passing', ''];
  if (all.length === 0) {
    return [
      '# From what was asked for, to what is passing',
      '',
      'No plan has been kept here, so there is nothing to trace. `tewip plan "<what it should do>"`',
      'writes one, and `tewip write` turns its scenarios into tests.',
    ].join('\n');
  }
  lines.push(
    `${all.length} scenario(s) across ${traced.length} requirement(s): ${count('passing')} passing, ${count('failing')} failing, ${count('never-run')} never run, ${count('not-covered')} not covered.`,
    '',
    'A scenario counts as covered only when a real test can be named, and as passing only when a real',
    'run attempted it. Everything else says what is missing instead.',
    '',
  );
  for (const requirement of traced) {
    lines.push(`## ${requirement.requirement}${requirement.ticket ? ` (${requirement.ticket})` : ''}`, '');
    for (const s of requirement.scenarios) {
      lines.push(`- **${MARK[s.standing]}** — ${s.id}${s.priority ? ` (${s.priority})` : ''}: ${s.title}`);
      lines.push(`  - ${s.why}`);
      if (s.diagnosis) lines.push(`  - Diagnosis: ${s.diagnosis}`);
      // A run is only worth quoting when it says something about this scenario. Printing the last
      // run beside "no test can be named for it" invited the reader to think one had checked it.
      if (s.runId && s.test) lines.push(`  - From run \`${s.runId}\`${s.when ? ` on ${s.when.slice(0, 10)}` : ''}`);
    }
    lines.push('');
  }
  const worst = all.filter((s) => s.standing === 'failing' || s.standing === 'not-covered');
  if (worst.length > 0) {
    lines.push('## What to do first', '');
    for (const s of worst.slice(0, 5)) lines.push(`- ${s.standing === 'failing' ? `fix or triage ${s.test}` : `write a test for ${s.id}: ${s.title}`}`);
    lines.push('');
  }
  lines.push('Every line above comes from a plan Tewip wrote and a run it recorded. Nothing is inferred.');
  return lines.join('\n');
}
