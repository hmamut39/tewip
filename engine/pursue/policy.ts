// Phase 19: a goal instead of a verb.
//
// "Agentic" usually means a model deciding what to do next. That is the part of agentic software
// that teams roll back: an agent that chooses freely is an agent nobody can predict, and its
// reasons are a paragraph rather than a rule. Tewip already answers this a level down - rules
// before models - and the same answer works here. What to do next is a **policy over observed
// state**, written out, ordered, and testable. The model is still used for the work itself, where
// it is good; it is not used to decide whether to act, where it is a liability.
//
// The other half is permission. Deciding is free and always allowed. Doing anything that changes a
// file is refused unless the person asked for it, and even then only through the gates that
// already prove a change before keeping it. An agent that cannot be stopped is not autonomy, it is
// a hazard.
export interface Observed {
  /** Failures in the most recent run that the goal covers, with what Tewip decided. */
  failing: Array<{ testId: string; category: string; confidence: number }>;
  /** Tests the goal covers that flake, with how often. */
  flaky: Array<{ testId: string; times: number }>;
  /** Scenarios of the goal that no test covers, worst priority first. */
  uncovered: Array<{ id: string; title: string; priority: string }>;
  /** Tests the goal covers that ran and passed. */
  passing: number;
  /** True when no run has been kept for this project at all. */
  noHistory: boolean;
}

export type Act =
  | 'look-first' // nothing has been observed yet; there is nothing to reason about
  | 'triage-real-bug' // something the goal depends on is broken, and a person should see it
  | 'rerun-environment' // the failures are the machine, not the code
  | 'settle-flaky' // the failures come and go, and the test is the problem
  | 'triage-undecided' // something the goal depends on is failing and Tewip cannot say why
  | 'cover-gap' // nothing is failing, but something important is unchecked
  | 'attest' // the goal is met, as far as anything here can show
  | 'stand-down'; // the goal names nothing this project knows about

export interface Decision {
  act: Act;
  /** One sentence: what Tewip will do, or would do. */
  next: string;
  /** Why this and not something else, in terms of what was observed. */
  why: string;
  /** What it is reacting to, so the reasoning can be checked. */
  evidence: string[];
  /** True when doing it changes a file, and therefore needs the person to ask. */
  changesFiles: boolean;
}

const list = (items: string[], max = 3): string => items.slice(0, max).join(', ') + (items.length > max ? `, and ${items.length - max} more` : '');

/**
 * What to do next about a goal, in one pass, most urgent first.
 *
 * The order is the argument. A real bug beats everything, because the goal is already broken. The
 * environment comes next, because nothing about the code has been shown and touching tests would
 * be guessing. Flakiness comes third: the code may be fine and the test is lying. Only when
 * nothing is failing is a coverage gap worth spending on, and only when nothing is failing and
 * nothing is missing is the goal worth attesting to.
 */
export function decide(goal: string, seen: Observed): Decision {
  if (seen.noHistory) {
    return {
      act: 'look-first',
      next: 'run `tewip explain <report>` on a test report, so there is something to reason about',
      why: 'no run has been kept for this project, so nothing is known about the goal yet - and guessing from the name of a goal would be inventing',
      evidence: [],
      changesFiles: false,
    };
  }

  const realBugs = seen.failing.filter((f) => f.category === 'REAL_BUG');
  if (realBugs.length > 0) {
    return {
      act: 'triage-real-bug',
      next: `put ${realBugs.length} failing test(s) in front of a person: ${list(realBugs.map((f) => f.testId))}`,
      why: `the goal is already broken: Tewip calls ${realBugs.length === 1 ? 'this failure' : 'these failures'} a real bug, which is the one kind it will not work around`,
      evidence: realBugs.map((f) => `${f.testId}: REAL_BUG at ${f.confidence.toFixed(2)}`),
      changesFiles: false,
    };
  }

  const env = seen.failing.filter((f) => f.category === 'ENV');
  if (env.length > 0 && env.length === seen.failing.length) {
    return {
      act: 'rerun-environment',
      next: `re-run, and do not touch the tests: ${list(env.map((f) => f.testId))}`,
      why: 'every failure the goal depends on is the environment, so nothing has been shown about the code and changing a test would be guessing',
      evidence: env.map((f) => `${f.testId}: ENV at ${f.confidence.toFixed(2)}`),
      changesFiles: false,
    };
  }

  const timing = seen.failing.filter((f) => f.category === 'TIMING');
  if (timing.length > 0 || seen.flaky.length > 0) {
    const worst = seen.flaky.slice().sort((a, b) => b.times - a.times);
    return {
      act: 'settle-flaky',
      next: worst.length > 0 ? `settle ${worst[0].testId}, which has flaked ${worst[0].times} time(s)` : `settle ${list(timing.map((f) => f.testId))}`,
      why: 'the goal is not broken, but the tests watching it come and go, so nobody can tell whether it is broken',
      evidence: [...timing.map((f) => `${f.testId}: TIMING at ${f.confidence.toFixed(2)}`), ...worst.map((f) => `${f.testId}: flaked ${f.times} time(s)`)],
      changesFiles: true,
    };
  }

  // Anything still failing has to be dealt with before anything else is spent on. Without this the
  // policy read "3 failing" in its own state line and then said "nothing the goal depends on is
  // failing", because undecided failures matched none of the branches above - the exact shape of
  // error this project exists to refuse.
  if (seen.failing.length > 0) {
    return {
      act: 'triage-undecided',
      next: `put ${seen.failing.length} failing test(s) in front of a person: ${list(seen.failing.map((f) => f.testId))}`,
      why: `the goal is failing and Tewip cannot say why: ${list([...new Set(seen.failing.map((f) => f.category))], 4)}. It will not move on to anything else while something it is watching is red`,
      evidence: seen.failing.map((f) => `${f.testId}: ${f.category}${f.confidence ? ` at ${f.confidence.toFixed(2)}` : ' (undiagnosed)'}`),
      changesFiles: false,
    };
  }

  if (seen.uncovered.length > 0) {
    const first = seen.uncovered[0];
    return {
      act: 'cover-gap',
      next: `write a test for ${first.id}: ${first.title}`,
      why: `nothing the goal depends on is failing, so the next thing worth spending on is what nothing is checking - ${seen.uncovered.length} scenario(s), worst first`,
      evidence: seen.uncovered.slice(0, 5).map((u) => `${u.id} (${u.priority || 'no priority'}): ${u.title}`),
      changesFiles: true,
    };
  }

  if (seen.passing > 0) {
    return {
      act: 'attest',
      next: 'produce the evidence bundle with `tewip attest`, and stop',
      why: `everything the goal covers ran and passed (${seen.passing} test(s)), and nothing it depends on is unchecked. There is no next action worth taking`,
      evidence: [`${seen.passing} test(s) passed in the last run`],
      changesFiles: false,
    };
  }

  return {
    act: 'stand-down',
    next: 'nothing: name the goal in words this project uses, or check the project is the right one',
    why: `nothing kept here matches "${goal.slice(0, 60)}" - no test, no scenario, no failure - so acting would mean acting on something Tewip cannot see`,
    evidence: [],
    changesFiles: false,
  };
}
