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

/**
 * Why no test could be named - and what that does and does not establish.
 *
 * "no test in this project can be named for it, so nothing is checking it" was printed whatever the
 * reason, including when **no run had been kept here at all**. Field-tested on this repository, which
 * has 1,095 passing tests and a kept history belonging to a different project: all twelve scenarios
 * of a real plan came back "nothing is checking it". Tewip was not looking at this project's tests,
 * because it only ever sees the tests a kept run names, and it said so as though it had looked.
 *
 * The distinction matters because the two cases call for opposite actions: write a test, or keep
 * your runs so the ones you have can be seen.
 */
function notCoveredBecause(runs: RunSummary[], knownTests: number): string {
  if (runs.length === 0) {
    return 'no run has been kept for this project, so Tewip has no list of its tests to match against - this is not a claim that nothing checks it. Run `tewip explain <report>` once and ask again';
  }
  return `no test among the ${knownTests} that the ${runs.length} kept run(s) name matches it, so nothing Tewip can see is checking it`;
}

/** Joins one plan to what the runs actually say. Nothing here is inferred from anything else. */
export function tracePlan(plan: PlanFile, runs: RunSummary[], records: TriageRecord[]): TracedRequirement {
  const newest = runs.at(-1);
  const attempted = newest ? Object.keys(newest.attempts ?? {}) : [];
  const everAttempted = new Set(runs.flatMap((r) => Object.keys(r.attempts ?? {})));
  // A scenario's own id was matched against the **newest run only**, so a test that ran last week
  // and not today could not be found at all - and the answer for it was "no test in this project can
  // be named for it, so nothing is checking it", which is a different and much stronger claim than
  // "it did not run today". The branch below that exists to say exactly that ("ran before but not in
  // the last run") was unreachable for every scenario the plan did not name a test for.
  const everyTest = [...everAttempted];
  const failures = new Map<string, TriageRecord>();
  for (const record of records) if (record.runId === newest?.runId) failures.set(record.testId, record);

  const scenarios = plan.scenarios.map((scenario): TracedScenario => {
    const test = testFor(scenario, everyTest);
    const base = { id: scenario.id, title: scenario.title, priority: scenario.priority ?? '', test, runId: newest?.runId ?? '', when: newest?.finishedAt ?? '' };
    if (!test) {
      return { ...base, standing: 'not-covered', diagnosis: '', why: notCoveredBecause(runs, everAttempted.size) };
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
/**
 * The report.
 *
 * `runsKept` is passed separately because the scenarios cannot carry it. With no run history at
 * all, every scenario comes back `never run` - true of each one and misleading as a whole: it reads
 * as a measurement of a suite nobody has exercised, when the truth is that nothing has been
 * recorded here to measure. The footer made it worse, claiming the lines came from "a run it
 * recorded" when there was no run.
 */
export function renderTrace(traced: TracedRequirement[], runsKept = 1): string {
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
  );
  if (runsKept === 0) {
    lines.push(
      '**No run has been kept here, so nothing below says whether anything passes.** Every scenario',
      'reads "never run" because there is no run to have attempted it - not because the tests were',
      'written and then left alone. Run `tewip explain <report>` on a real run first, and this becomes',
      'an answer rather than a list.',
      '',
    );
  } else {
    lines.push(
      'A scenario counts as covered only when a real test can be named, and as passing only when a real',
      'run attempted it. Everything else says what is missing instead.',
      '',
    );
  }
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
  lines.push(
    runsKept === 0
      ? 'Every line above comes from a plan Tewip wrote. No run was recorded here, so nothing above was checked against one.'
      : 'Every line above comes from a plan Tewip wrote and a run it recorded. Nothing is inferred.',
  );
  return lines.join('\n');
}
