// Did that test actually reproduce the incident?
//
// This is the whole of Phase 16 in one question, and getting it wrong is how a tool like this
// becomes worthless. A test that fails is not a reproduction. A test with a typo fails. A test
// against a missing fixture fails. A test that asserts the opposite of the truth fails. Each of
// those would let Tewip announce "reproduced your incident" and hand over something that proves
// nothing, and then the fix that makes it pass would fix nothing.
//
// So a reproduction has to fail **for the incident's reason**, and that is checkable without a
// model: the error the test produced and the error production reported have to be the same error.
// Everything else - a pass, a failure of a different kind, a crash before the test ran - is
// refused and said out loud.
import { errorShape } from '../signature.ts';
import type { Incident } from './incident.ts';

export type Verdict = 'reproduced' | 'passed' | 'failed-differently' | 'never-ran';

export interface Judgement {
  verdict: Verdict;
  /** What a person is told, in one sentence they can check against the two errors. */
  why: string;
  /** How close the two errors were, for the report: 'same type and message', 'same type' ... */
  match: string;
}

/** Words that mean the test never got as far as exercising anything. */
const NEVER_RAN =
  /\b(?:cannot find module|ModuleNotFoundError|No module named|SyntaxError|IndentationError|fixture '[^']+' not found|ERR_MODULE_NOT_FOUND|NoClassDefFoundError|ClassNotFoundException|command not found|no tests? (?:found|ran)|collection failure)\b/i;

const typeOf = (text: string): string => /\b([\w.]*(?:Error|Exception|Fault))\b/.exec(text)?.[1]?.split('.').pop() ?? '';

/** The words of an error, without the parts that differ every run. */
const wordsOf = (text: string): Set<string> =>
  new Set(
    errorShape(text)
      .toLowerCase()
      .match(/[a-z][a-z-]{2,}/g)
      ?.filter((w) => !['error', 'exception', 'the', 'and', 'for', 'with', 'from', 'test', 'failed', 'assert'].includes(w)) ?? [],
  );

/**
 * Judges one test run against the incident it was written for.
 *
 * `passed` is not a near miss. It means the test does not exercise the broken path at all, and the
 * honest thing is to say the reproduction failed, not to weaken the test until it goes red.
 */
export function judgeReproduction(incident: Incident, run: { passed: boolean; output: string }): Judgement {
  if (NEVER_RAN.test(run.output)) {
    return {
      verdict: 'never-ran',
      why: 'the test never ran - something was missing or would not compile - so it shows nothing about the incident',
      match: 'none',
    };
  }
  if (run.passed) {
    return {
      verdict: 'passed',
      why: 'the test passes against the code that is broken in production, so it does not exercise what broke. It is not a reproduction, and weakening it until it fails would prove nothing',
      match: 'none',
    };
  }

  const wanted = `${incident.errorType} ${incident.errorMessage}`.trim();
  const sameType = Boolean(incident.errorType) && typeOf(run.output) === typeOf(wanted);
  const theirs = wordsOf(wanted);
  const ours = wordsOf(run.output);
  const shared = [...theirs].filter((w) => ours.has(w));
  // Most of the incident's own words, not most of the test output's: a long stack trace should not
  // earn a match by sheer length.
  const overlap = theirs.size > 0 ? shared.length / theirs.size : 0;

  if (sameType && overlap >= 0.5) {
    return { verdict: 'reproduced', why: `the test fails with the same error production reported (${typeOf(wanted)}), and most of the same words`, match: 'same type and message' };
  }
  if (sameType) {
    return { verdict: 'reproduced', why: `the test fails with ${typeOf(wanted)}, the same error type production reported, though the message differs`, match: 'same type' };
  }
  if (overlap >= 0.7 && theirs.size >= 3) {
    return { verdict: 'reproduced', why: 'the test fails with the same message production reported, although neither names an error type', match: 'same message' };
  }
  return {
    verdict: 'failed-differently',
    why: `the test fails, but not with the incident's error: production reported ${wanted.slice(0, 80) || 'its own error'}, and the test reported ${errorLine(run.output)}`,
    match: 'none',
  };
}

/**
 * The line of a runner's output that is actually the error. Quoting the first non-empty line put
 * "RUN v5.0.2 C:/Users/..." into a real report as though it were what the test said - a banner, not
 * a finding, and exactly the loose evidence this project refuses everywhere else.
 */
function errorLine(output: string): string {
  // Two passes, because a runner prints its own status lines too: " FAIL tests/a.test.js" says
  // which file failed, not what went wrong. A named error always wins over a status line.
  const named = /\b(?:\w*Error|\w*Exception|expected|Expected|assert)\b/;
  const anyFailure = /\b(?:FAIL|failed|failure)\b/i;
  const noise = /^\s*(?:RUN|DEV|WATCH)\b/;
  const lines = output.split('\n').filter((l) => l.trim() && !noise.test(l));
  const found = lines.find((l) => named.test(l)) ?? lines.find((l) => anyFailure.test(l)) ?? lines[0];
  return (found ?? '').trim().slice(0, 100);
}

/** What to do about each verdict, for the report. */
export const nextStep: Record<Verdict, string> = {
  reproduced: 'keep this test: it is red for the reason production was, so a fix that turns it green has fixed the incident',
  passed: 'do not keep this test. Either the incident depends on data or state the test does not create, or it is not in this code at all',
  'failed-differently': 'do not keep this test: it is broken in its own way, which would be mistaken for the incident later',
  'never-ran': 'fix the setup and try again; nothing has been shown either way',
};
