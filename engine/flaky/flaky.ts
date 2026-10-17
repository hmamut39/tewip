// The flake dossier: what Tewip knows about a test that nobody else can know.
//
// A flaky-test product counts retries. Tewip has something better - it already decided, failure by
// failure, whether each one was the test being unreliable, the environment being broken, or the
// application being wrong. So this answers the question a person actually has on Monday morning:
// which tests are wasting our time, how much, and is it safe to quarantine one?
//
// Everything here is read from history Tewip already kept. No model, no test run, no cost.
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';

export type FlakeVerdict = 'quarantine' | 'fix-now' | 'watch' | 'release';

export interface FlakyTest {
  testId: string;
  /** Last part of the id: the test's own name. */
  title: string;
  file: string;
  /** Runs in which this test failed at least once. */
  failedRuns: number;
  /** Runs in which it ran at all, from the run summaries. */
  totalRuns: number;
  /** Failed attempts, counting retries: what the CI time is actually spent on. */
  failedAttempts: number;
  /** Milliseconds spent on those failed attempts. */
  wastedMs: number;
  /** How often it failed and then passed on a retry in the same run. */
  recoveredOnRetry: number;
  /** Branches it failed on. Failing on many is the test's fault, not one person's change. */
  branches: string[];
  /** What Tewip called those failures, most common first. */
  categories: Array<{ category: string; count: number }>;
  firstSeen: string;
  lastSeen: string;
  verdict: FlakeVerdict;
  /** The sentence that justifies the verdict, in facts. */
  why: string;
}

export interface FlakeOptions {
  /** Only runs on or after this time. */
  since?: string;
  /** How many runs a test must have failed in before quarantine is even considered. */
  minRuns?: number;
  /** A test that fails this often is broken, not flaky: fix it, do not hide it. */
  alwaysFailsAbove?: number;
}

const titleOf = (testId: string) => testId.split(' > ').at(-1) ?? testId;
const fileOf = (testId: string, record?: TriageRecord) => record?.file ?? testId.split(' > ').find((p) => /\.(spec|test)\./.test(p)) ?? '';

/**
 * A test's story across the kept runs. `records` are the failures Tewip diagnosed; `runs` say how
 * often each test ran at all, which is what turns a count into a rate.
 */
export function flakyTests(records: TriageRecord[], runs: RunSummary[], options: FlakeOptions = {}): FlakyTest[] {
  const { since = '', minRuns = 2, alwaysFailsAbove = 0.8 } = options;
  const inWindow = runs.filter((r) => (r.startedAt ?? '') >= since);
  const runIds = new Set(inWindow.map((r) => r.runId));
  const branchOf = new Map(inWindow.map((r) => [r.runId, r.branch ?? '']));
  const failures = records.filter((r) => runIds.has(r.runId) || (!r.runId && !since));

  const ranIn = new Map<string, number>();
  for (const run of inWindow) for (const testId of Object.keys(run.attempts ?? {})) ranIn.set(testId, (ranIn.get(testId) ?? 0) + 1);

  const byTest = new Map<string, TriageRecord[]>();
  for (const record of failures) byTest.set(record.testId, [...(byTest.get(record.testId) ?? []), record]);

  const out: FlakyTest[] = [];
  for (const [testId, all] of byTest) {
    const runsFailed = new Set(all.map((r) => r.runId));
    // A retry that passed: the same test, same run, a later attempt that is not in the failures.
    const attemptsByRun = new Map<string, TriageRecord[]>();
    for (const r of all) attemptsByRun.set(r.runId, [...(attemptsByRun.get(r.runId) ?? []), r]);
    let recovered = 0;
    for (const [runId, attempts] of attemptsByRun) {
      const ran = inWindow.find((run) => run.runId === runId)?.attempts?.[testId] ?? attempts.length;
      if (ran > attempts.length) recovered++;
    }

    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.diagnosis?.category ?? 'UNKNOWN', (counts.get(r.diagnosis?.category ?? 'UNKNOWN') ?? 0) + 1);
    const categories = [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
    const times = all.map((r) => r.timestamp).sort();
    const branches = [...new Set([...runsFailed].map((id) => branchOf.get(id) ?? '').filter(Boolean))];
    const totalRuns = ranIn.get(testId) ?? runsFailed.size;

    const test: FlakyTest = {
      testId,
      title: titleOf(testId),
      file: fileOf(testId, all[0]),
      failedRuns: runsFailed.size,
      totalRuns,
      failedAttempts: all.length,
      wastedMs: all.reduce((sum, r) => sum + (r.duration ?? 0), 0),
      recoveredOnRetry: recovered,
      branches,
      categories,
      firstSeen: times[0] ?? '',
      lastSeen: times.at(-1) ?? '',
      verdict: 'watch',
      why: '',
    };
    Object.assign(test, decide(test, { minRuns, alwaysFailsAbove }));
    out.push(test);
  }
  return out.sort((a, b) => b.wastedMs - a.wastedMs || b.failedRuns - a.failedRuns);
}

const share = (test: FlakyTest) => (test.totalRuns > 0 ? test.failedRuns / test.totalRuns : 1);
const flakyShare = (test: FlakyTest) => {
  const flaky = test.categories.find((c) => c.category === 'TIMING')?.count ?? 0;
  return test.failedAttempts > 0 ? flaky / test.failedAttempts : 0;
};

/**
 * The decision, and why. Three rules, all conservative:
 *   a test that mostly fails is broken, not flaky - hiding it hides a real problem;
 *   a test whose failures Tewip read as the application being wrong is never quarantined;
 *   quarantine needs the test to have failed in several runs, and to be unreliable rather than
 *   consistently wrong.
 */
/** The verdict for one test, and the sentence that justifies it. Exported so it can be tested
 * against the shapes real projects produce rather than only through a whole report. */
export function decide(test: FlakyTest, { minRuns, alwaysFailsAbove }: { minRuns: number; alwaysFailsAbove: number }): Pick<FlakyTest, 'verdict' | 'why'> {
  const rate = share(test);
  const percent = `${Math.round(rate * 100)}% of the ${test.totalRuns} run(s) it was in`;
  const realBugs = test.categories.find((c) => c.category === 'REAL_BUG')?.count ?? 0;

  if (realBugs > 0 && realBugs >= test.failedAttempts / 2) {
    return { verdict: 'fix-now', why: `${realBugs} of its ${test.failedAttempts} failures looked like the application being wrong, not the test. Quarantining it would hide a bug.` };
  }
  if (rate > alwaysFailsAbove && test.totalRuns >= minRuns) {
    return { verdict: 'fix-now', why: `it fails in ${percent}. That is not flakiness, it is a test that does not work - hiding it would hide whatever it is telling you.` };
  }
  // Observed, not inferred. A test that failed and then passed on a retry within the same run did
  // both on the same code, same commit, same machine: that is not evidence of flakiness, it is
  // flakiness, and no diagnosis is needed to see it.
  //
  // This mattered more than it looks. Everything below rests on `flakyShare`, which counts how many
  // failures a *previous* `tewip explain` already called flaky - so on a project's raw history,
  // where nothing has been diagnosed yet, no test could ever qualify and the command recommended
  // quarantining nothing at all. Measured on 1,305 real failures from WordPress/gutenberg: **124 of
  // the 180 failing tests had recovered on retry, and all 124 were filed under "watch"**. One of
  // them had done it 93 separate times.
  //
  // Phase 56 is where this comes from: of the signals available when a test fails, non-determinism
  // is the one that is genuinely decisive, and it costs nothing to read.
  if (test.recoveredOnRetry > 0 && test.failedRuns >= minRuns) {
    const times = test.recoveredOnRetry === 1 ? 'once' : `${test.recoveredOnRetry} times`;
    const spread = test.branches.length > 1 ? ` It failed on ${test.branches.length} different branches, so it is the test rather than one person's change.` : '';
    return {
      verdict: 'quarantine',
      why: `it failed and then passed on a retry in the same run ${times}: the same code did both, which is what a flaky test is. It failed in ${percent}.${spread}`,
    };
  }
  if (test.failedRuns >= minRuns && flakyShare(test) >= 0.5) {
    const spread = test.branches.length > 1 ? ` It failed on ${test.branches.length} different branches, so it is the test rather than one person's change.` : '';
    return { verdict: 'quarantine', why: `it failed in ${percent}, and Tewip read most of those as the test being unreliable.${spread}` };
  }
  return { verdict: 'watch', why: `it failed in ${percent}: not often enough, or not consistently enough one thing, to act on yet.` };
}

/** What a week of this costs, so the number means something to whoever pays for CI. */
export function weeklyCost(tests: FlakyTest[], days: number): { minutes: number; attempts: number } {
  const wasted = tests.reduce((sum, t) => sum + t.wastedMs, 0);
  const attempts = tests.reduce((sum, t) => sum + t.failedAttempts, 0);
  const weeks = Math.max(days / 7, 0.1);
  return { minutes: Math.round(wasted / 60_000 / weeks), attempts: Math.round(attempts / weeks) };
}

/**
 * Tests that were quarantined and have stopped failing. Nobody ever takes a test out of quarantine,
 * so this looks for the ones that have earned it: no failure in the window, and they ran.
 */
export function readyToRelease(quarantined: string[], records: TriageRecord[], runs: RunSummary[], since: string): string[] {
  const failed = new Set(records.filter((r) => r.timestamp >= since).map((r) => r.testId));
  const ran = new Set(runs.filter((r) => (r.startedAt ?? '') >= since).flatMap((r) => Object.keys(r.attempts ?? {})));
  return quarantined.filter((testId) => ran.has(testId) && !failed.has(testId));
}
