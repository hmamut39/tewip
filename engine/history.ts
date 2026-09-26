// Point-in-time history: what the agent knew about a test when a given run finished.
// Rules must never see runs that happened after the failure they are judging.
import type { RunSummary, TriageRecord } from '../reporters/types.ts';
import { errorShape, errorSignature } from './signature.ts';

/** How many of a test's most recent runs the rules look at. */
export const HISTORY_WINDOW = 50;

export interface TestHistory {
  testId: string;
  /** Attempts in the window, up to and including the run being diagnosed. */
  runs: number;
  failures: number;
  failureRate: number;
  /** Distinct error signatures across all failures in the window. */
  distinctErrors: number;
  /** Consecutive runs, ending with the current one, where every attempt failed. */
  failingStreak: number;
  /** Distinct error signatures among the failures inside that streak. */
  streakDistinctErrors: number;
  /** Failures in the window before the streak started. */
  failuresBeforeStreak: number;
  /** Passing attempts in the window before the streak started. */
  passesBeforeStreak: number;
  /** Attempts of this test in the run being diagnosed (retries included). */
  currentRunAttempts: number;
  /** Failed attempts in that run; fewer than currentRunAttempts means a retry passed. */
  currentRunFailures: number;
  /** Attempts / failures on the same git commit as this run (re-runs included); 0 when the SHA is unknown. */
  sameCommitAttempts: number;
  sameCommitFailures: number;
  /** Passing attempts on other (earlier) commits in the window. */
  passesOnOtherCommits: number;
  /** Runs on other commits in the window where this test failed at least once. */
  failingRunsOnOtherCommits: number;
  /**
   * How often the test switched between passing and failing on this run's own branch, in time
   * order. A test broken by one change flips once; a flaky test keeps flipping.
   */
  alternations: number;
  /**
   * Error shapes of this test's earlier flakes: runs before this one where it failed and then
   * passed on a retry of the same code. A test that has flaked before is a known flaky test.
   */
  earlierFlakeShapes: string[];
}

export interface RunContext {
  runId: string;
  /** Branch the run tested; '' when unknown. */
  branch: string;
  /** Distinct tests attempted in the run. */
  testsAttempted: number;
  failures: TriageRecord[];
  /**
   * True when the kept runs record which commit they tested. Without that, a test that flips
   * between passing and failing cannot be told apart from code someone kept changing, so any rule
   * reasoning about flipping has to decline rather than guess.
   */
  commitsKnown: boolean;
}

interface RunEntry {
  runId: string;
  /** ISO time used to order runs. */
  at: string;
  /** Git commit the run tested; '' when unknown. */
  sha: string;
  branch: string;
  attempts: Record<string, number>;
  failures: TriageRecord[];
}

const distinct = (records: TriageRecord[]) => new Set(records.map((r) => errorSignature(r.errorMessage))).size;

export class HistoryIndex {
  private readonly runs: RunEntry[];
  private readonly position = new Map<string, number>();

  constructor(records: TriageRecord[], summaries: RunSummary[]) {
    const entries = new Map<string, RunEntry>();
    const entry = (runId: string, at: string, sha: string) => {
      const existing = entries.get(runId);
      if (existing) {
        if (at < existing.at) existing.at = at;
        existing.sha ||= sha;
        return existing;
      }
      const created: RunEntry = { runId, at, sha, branch: '', attempts: {}, failures: [] };
      entries.set(runId, created);
      return created;
    };

    for (const s of summaries) {
      const e = entry(s.runId, s.startedAt, s.gitSha);
      e.branch ||= s.branch ?? '';
      for (const [testId, n] of Object.entries(s.attempts)) e.attempts[testId] = (e.attempts[testId] ?? 0) + n;
    }
    for (const r of records) entry(r.runId, r.timestamp, r.gitSha).failures.push(r);
    // A run with no summary line: its failures are the only attempts we know about.
    for (const e of entries.values()) {
      for (const r of e.failures) {
        const failed = e.failures.filter((f) => f.testId === r.testId).length;
        e.attempts[r.testId] = Math.max(e.attempts[r.testId] ?? 0, failed);
      }
    }

    this.runs = [...entries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId));
    this.runs.forEach((e, i) => this.position.set(e.runId, i));
  }

  /** Run ids, oldest first. */
  get runIds(): string[] {
    return this.runs.map((e) => e.runId);
  }

  historyAsOf(testId: string, runId: string): TestHistory {
    const until = this.indexOf(runId);
    const entries = this.runs
      .slice(0, until + 1)
      .filter((e) => (e.attempts[testId] ?? 0) > 0)
      .slice(-HISTORY_WINDOW)
      .map((e) => ({ sha: e.sha, branch: e.branch, attempts: e.attempts[testId], failures: e.failures.filter((f) => f.testId === testId) }));
    const sha = this.runs[until].sha;
    const sameCommit = sha ? entries.filter((e) => e.sha === sha) : [];
    const otherCommits = sha ? entries.filter((e) => e.sha !== sha) : [];

    let streakStart = entries.length;
    while (streakStart > 0 && entries[streakStart - 1].failures.length >= entries[streakStart - 1].attempts) streakStart--;
    const before = entries.slice(0, streakStart);
    const streak = entries.slice(streakStart);

    const runs = entries.reduce((sum, e) => sum + e.attempts, 0);
    const allFailures = entries.flatMap((e) => e.failures);
    const failuresBeforeStreak = before.reduce((sum, e) => sum + e.failures.length, 0);
    const current = this.runs[until].attempts[testId] ? entries[entries.length - 1] : undefined;
    const sum = (xs: typeof entries, f: (e: (typeof entries)[number]) => number) => xs.reduce((n, e) => n + f(e), 0);
    return {
      currentRunAttempts: current?.attempts ?? 0,
      currentRunFailures: current?.failures.length ?? 0,
      sameCommitAttempts: sum(sameCommit, (e) => e.attempts),
      sameCommitFailures: sum(sameCommit, (e) => e.failures.length),
      passesOnOtherCommits: sum(otherCommits, (e) => e.attempts - e.failures.length),
      failingRunsOnOtherCommits: otherCommits.filter((e) => e.failures.length > 0).length,
      testId,
      runs,
      failures: allFailures.length,
      failureRate: runs === 0 ? 0 : allFailures.length / runs,
      distinctErrors: distinct(allFailures),
      failingStreak: streak.length,
      streakDistinctErrors: distinct(streak.flatMap((e) => e.failures)),
      failuresBeforeStreak,
      passesBeforeStreak: before.reduce((sum, e) => sum + e.attempts, 0) - failuresBeforeStreak,
      // Counted within this run's own branch. Across branches the same test legitimately passes on
      // one line of work and fails on another, which looks like flipping but is not.
      earlierFlakeShapes: [
        ...new Set(
          (current ? entries.slice(0, -1) : entries)
            .filter((e) => e.failures.length > 0 && e.failures.length < e.attempts)
            .flatMap((e) => e.failures.map((f) => errorShape(f.errorMessage))),
        ),
      ],
      alternations: entries
        .filter((e) => e.branch === this.runs[until].branch)
        .reduce<{ count: number; last: boolean | null }>(
          (acc, e) => {
            const failed = e.failures.length > 0;
            return { count: acc.count + (acc.last !== null && acc.last !== failed ? 1 : 0), last: failed };
          },
          { count: 0, last: null },
        ).count,
    };
  }

  runContext(runId: string): RunContext {
    const e = this.runs[this.indexOf(runId)];
    // "Some run knows its commit" is the weakest true statement available: a single kept run with a
    // sha means the history can distinguish code changes from flakiness at all.
    const commitsKnown = this.runs.some((r) => Boolean(r.sha));
    return { runId, branch: e.branch, testsAttempted: Object.keys(e.attempts).length, failures: e.failures, commitsKnown };
  }

  private indexOf(runId: string): number {
    const i = this.position.get(runId);
    if (i === undefined) throw new Error(`run ${runId} is not in the history index`);
    return i;
  }
}
