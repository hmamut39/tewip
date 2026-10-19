// What a verdict is made of: the questions, the standings, and everything `decide` is allowed to
// read. Split from verdict.ts when it passed this project's 300-line rule.
//
// Worth keeping together, because the shape of this file is the argument. Every field that can be
// absent is nullable or counted, and the comments say which absence means what - an empty list and
// a question nobody answered look identical otherwise, and four separate phases found the gate
// reading one as the other.

export type Standing = 'met' | 'not-met' | 'not-applicable' | 'not-checked';


export interface Check {
  /** What was asked, in a reviewer's words. */
  question: string;
  standing: Standing;
  /** The answer, with the evidence that supports it. */
  answer: string;
  /** Which layer decided, so the claim can be traced to something with a measured accuracy. */
  decidedBy: string;
}

export type Verdict = 'ready' | 'not-ready' | 'cannot-say';

export interface Decision {
  verdict: Verdict;
  /** One sentence a person can act on. */
  headline: string;
  checks: Check[];
  /** What this verdict says nothing about. Always non-empty. */
  notChecked: string[];
}

export interface Evidence {
  /** Source files the change touched (not tests). */
  changedSource: string[];
  /** Test files the change touched. */
  changedTests: string[];
  /** Test files that reach the changed source, and how. */
  covering: Array<{ testFile: string; how: string }>;
  /**
   * What a coverage report the project already produces says about the changed files, when there is
   * one. Imports cannot see a test that posts a GraphQL query or hits an HTTP route; a coverage
   * report can, because it records what actually ran.
   */
  coverage?: { from: string; executed: string[]; notExecuted: string[] };
  /** Tests in the change that could never fail. */
  cannotFail: Array<{ name: string; file: string; line: number; why: string }>;
  /** Tests in the change that compare no value. */
  crashOnly: number;
  /** Tests in the change vouch would not call either way. */
  couldNotJudge: number;
  /**
   * How many deliberate changes were actually made and run, and why none were when none were.
   *
   * `unnoticed` being empty means one of two opposite things: every change was caught, or nothing
   * was ever tried. Asked for `--prove` on a project whose runner is not installed, the gate said
   * "every deliberate change made to this code was noticed" - about no changes at all, in the
   * strongest claim it makes, to somebody who had asked for it specifically.
   */
  proofsTried: number;
  /** Why nothing could be proved, when nothing could. */
  proofSkipped: string;
  /** Plan files in .tewip/plans that could not be parsed, so their scenarios were never compared. */
  plansUnreadable: number;
  /** Plans that were about this change at all. Zero means the question went unanswered, not that it passed. */
  plansConsidered: number;
  /** Deliberate changes that no covering test noticed. Null when proving was not run. */
  unnoticed: Array<{ file: string; line: number; kind: string }> | null;
  /** Failures in the most recent kept run that touch the changed files. */
  failingNow: Array<{ testId: string; category: string }>;
  /** True when this project keeps no run history, so "nothing is failing" would be an assumption. */
  noHistory: boolean;
  /** Scenarios of a kept plan that the change relates to and nothing covers. Null when no plans exist. */
  uncovered: Array<{ id: string; title: string }> | null;
  /** Rules from this project's own standards that the change breaks. Null when it has written none. */
  brokenRules: Array<{ standard: string; file: string; line: number; why: string }> | null;
}

/**
 * The verdict, in a fixed order: what is broken first, then what cannot be believed, then what is
 * missing, and only then "ready".
 */
