// Point-in-time history: what the agent knew about a test when a given run finished.
// Rules must never see runs that happened after the failure they are judging.
import type { RunSummary, TriageRecord } from '../reporters/types.ts';
import { errorSignature } from './signature.ts';

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
}

export interface RunContext {
  runId: string;
  /** Distinct tests attempted in the run. */
  testsAttempted: number;
  failures: TriageRecord[];
}

interface RunEntry {
  runId: string;
  /** ISO time used to order runs. */
  at: string;
  attempts: Record<string, number>;
  failures: TriageRecord[];
}

const distinct = (records: TriageRecord[]) => new Set(records.map((r) => errorSignature(r.errorMessage))).size;

export class HistoryIndex {
  private readonly runs: RunEntry[];
  private readonly position = new Map<string, number>();

  constructor(records: TriageRecord[], summaries: RunSummary[]) {
    const entries = new Map<string, RunEntry>();
    const entry = (runId: string, at: string) => {
      const existing = entries.get(runId);
      if (existing) {
        if (at < existing.at) existing.at = at;
        return existing;
      }
      const created: RunEntry = { runId, at, attempts: {}, failures: [] };
      entries.set(runId, created);
      return created;
    };

    for (const s of summaries) {
      const e = entry(s.runId, s.startedAt);
      for (const [testId, n] of Object.entries(s.attempts)) e.attempts[testId] = (e.attempts[testId] ?? 0) + n;
    }
    for (const r of records) entry(r.runId, r.timestamp).failures.push(r);
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
      .map((e) => ({ attempts: e.attempts[testId], failures: e.failures.filter((f) => f.testId === testId) }));

    let streakStart = entries.length;
    while (streakStart > 0 && entries[streakStart - 1].failures.length >= entries[streakStart - 1].attempts) streakStart--;
    const before = entries.slice(0, streakStart);
    const streak = entries.slice(streakStart);

    const runs = entries.reduce((sum, e) => sum + e.attempts, 0);
    const allFailures = entries.flatMap((e) => e.failures);
    const failuresBeforeStreak = before.reduce((sum, e) => sum + e.failures.length, 0);
    return {
      testId,
      runs,
      failures: allFailures.length,
      failureRate: runs === 0 ? 0 : allFailures.length / runs,
      distinctErrors: distinct(allFailures),
      failingStreak: streak.length,
      streakDistinctErrors: distinct(streak.flatMap((e) => e.failures)),
      failuresBeforeStreak,
      passesBeforeStreak: before.reduce((sum, e) => sum + e.attempts, 0) - failuresBeforeStreak,
    };
  }

  runContext(runId: string): RunContext {
    const e = this.runs[this.indexOf(runId)];
    return { runId, testsAttempted: Object.keys(e.attempts).length, failures: e.failures };
  }

  private indexOf(runId: string): number {
    const i = this.position.get(runId);
    if (i === undefined) throw new Error(`run ${runId} is not in the history index`);
    return i;
  }
}
