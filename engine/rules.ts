// The phase-2 rule set. Every rule is deterministic: same record + history → same answer.
// A rule returns null when it doesn't apply, or an outcome with category null when it
// looked and declined; the declined evidence tells phase 3 what was already ruled out.
import type { Evidence, RootCause, TriageRecord } from '../reporters/types.ts';
import { isElementNotFound, networkSignal, valueMismatch } from './error-parse.ts';
import { locatorDrift, locatorDriftStrict } from './drift-rules.ts';
import type { RunContext, TestHistory } from './history.ts';
import { errorScenarioOf } from './llm/context.ts';
import { errorShape, truncate } from './signature.ts';
import type { SnapshotElement } from './snapshot.ts';

export const MASS_MIN_TESTS = 3;
export const MASS_MIN_SHARE = 0.3;
export const FLAKY_MIN_RATE = 0.2;
export const FLAKY_MAX_RATE = 0.8;
export const TIMING_MIN_RUNS = 3;
export { DRIFT_MIN_SIMILARITY } from './drift-rules.ts';

export interface RuleInput {
  record: TriageRecord;
  history: TestHistory;
  run: RunContext;
  /** Lazy: only rules that need the page snapshot pay for reading it. */
  loadSnapshot: () => SnapshotElement[] | null;
  /** Lazy: requests that failed (HTTP >= 400 or no response) during the test, from its trace. */
  loadFailedRequests?: () => Array<{ url: string; status: number | null }>;
}

export interface RuleOutcome {
  /** null: the rule examined the failure and declined; the evidence says why. */
  category: RootCause | null;
  confidence: number;
  evidence: Evidence[];
}

export interface Rule {
  id: string;
  evaluate(input: RuleInput): RuleOutcome | null;
}

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

function declined(source: string, message: string, data?: Record<string, unknown>): RuleOutcome {
  return { category: null, confidence: 0, evidence: [{ source, message, data }] };
}

/**
 * Many tests in one run failing with the same error shape → one shared cause outside the
 * tests. Many failures with *different* errors (e.g. a bad deploy) are not enough, and
 * neither are many "element not found" timeouts: those share a shape only because the call
 * log (with each test's own locator) is left out, and they point to a UI change or a broken
 * page rather than to the environment (found in the drift lab, rules-3).
 */
const envMassFailure: Rule = {
  id: 'env-mass-failure',
  evaluate({ record, run }) {
    if (isElementNotFound(record.errorMessage)) {
      const alike = run.failures.filter((f) => isElementNotFound(f.errorMessage)).length;
      if (alike >= MASS_MIN_TESTS) return declined(this.id, `${alike} tests in this run could not find their elements: a UI change or a broken page, not by itself an environment signal`);
      return null;
    }
    const shape = errorShape(record.errorMessage);
    const sameShape = new Set(run.failures.filter((f) => !isElementNotFound(f.errorMessage) && errorShape(f.errorMessage) === shape).map((f) => f.testId));
    const failing = new Set(run.failures.map((f) => f.testId));
    const attempted = Math.max(run.testsAttempted, failing.size, 1);
    const share = sameShape.size / attempted;
    if (sameShape.size >= MASS_MIN_TESTS && share >= MASS_MIN_SHARE) {
      return {
        category: 'ENV',
        confidence: Math.min(0.95, 0.6 + 0.35 * share),
        evidence: [
          {
            source: this.id,
            message: `${sameShape.size} of ${attempted} tests in this run failed with the same error: "${truncate(shape, 80)}"`,
            data: { tests: [...sameShape], share },
          },
        ],
      };
    }
    if (failing.size >= MASS_MIN_TESTS && failing.size / attempted >= MASS_MIN_SHARE) {
      const shapes = new Set(run.failures.map((f) => errorShape(f.errorMessage))).size;
      return declined(this.id, `${failing.size} of ${attempted} tests failed in this run, but with ${shapes} different errors, not one shared cause`);
    }
    return null;
  },
};

const envNetwork: Rule = {
  id: 'env-network',
  evaluate({ record }) {
    const signal = networkSignal(record.errorMessage);
    if (!signal) return null;
    return {
      category: 'ENV',
      confidence: signal.confidence,
      evidence: [{ source: this.id, message: `error shows a ${signal.kind} problem: "${truncate(signal.match, 60)}"`, data: { ...signal } }],
    };
  },
};

const DATA_COLLISION = /duplicate key value violates unique constraint|UNIQUE constraint failed|already exists/i;

/**
 * Tests colliding on shared data (two tests creating the same record, leftovers from another
 * test). Checked before the retry rule: a retry passing only means the collision did not
 * happen again. Found on Supabase CI (rules-4).
 */
const testDataCollision: Rule = {
  id: 'test-data-collision',
  evaluate({ record }) {
    const match = record.errorMessage.match(DATA_COLLISION)?.[0];
    if (!match) return null;
    return {
      category: 'TEST_DATA',
      confidence: 0.8,
      evidence: [{ source: this.id, message: `the test's data collided with data that already existed: "${truncate(match, 60)}"`, data: { match } }],
    };
  },
};

/**
 * The app's backend answered a server error (5xx) during the test. Checked before the retry
 * rule, which used to call these races. Declines when the test provokes errors on purpose, and
 * when the error is specific to this commit (possibly a backend bug the change introduced).
 */
const envServerError: Rule = {
  id: 'env-server-error',
  evaluate({ record, history, loadFailedRequests }) {
    const failure = (loadFailedRequests?.() ?? []).find((r) => r.status !== null && r.status >= 500);
    if (!failure) return null;
    const what = `${failure.url} returned ${failure.status} during the test`;
    if (errorScenarioOf(record.testId)) return declined(this.id, `${what}, but the test's name says it exercises error handling`);
    if (history.sameCommitAttempts > 0 && history.sameCommitFailures === history.sameCommitAttempts && history.passesOnOtherCommits > 0) {
      return declined(this.id, `${what}, but only on this commit while other commits pass: possibly a backend bug the change introduced`);
    }
    return { category: 'ENV', confidence: 0.7, evidence: [{ source: this.id, message: what, data: { ...failure } }] };
  },
};

/**
 * The test failed but another attempt of the same code in the same run passed: Playwright's
 * own "flaky" signal. A deterministic cause (real bug, drifted locator) would fail every
 * attempt. Confidence stays below the auto-fix threshold: the rule knows a race happened,
 * not where. Network signals are handled first by env-network.
 */
const timingRetryPass: Rule = {
  id: 'timing-retry-pass',
  evaluate({ history }) {
    const { currentRunAttempts: attempts, currentRunFailures: failures } = history;
    if (attempts < 2 || failures >= attempts) return null;
    return {
      category: 'TIMING',
      confidence: 0.75,
      evidence: [{ source: this.id, message: `${failures} of ${attempts} attempts in this run failed and another attempt of the same code passed`, data: { attempts, failures } }],
    };
  },
};

/** Intermittent failures whose error keeps changing: a race, not a deterministic break. */
const timingFlaky: Rule = {
  id: 'timing-flaky',
  evaluate({ history }) {
    const { runs, failures, failureRate, distinctErrors } = history;
    if (failureRate < FLAKY_MIN_RATE || failureRate > FLAKY_MAX_RATE) return null;
    const rate = `fails ${pct(failureRate)} of the time (${failures}/${runs} runs)`;
    if (runs < TIMING_MIN_RUNS) return declined(this.id, `${rate}, too few runs to call it flaky (need ${TIMING_MIN_RUNS})`);
    if (distinctErrors < 2) {
      return declined(this.id, `${rate} but always with the same error; rules can't tell a race from an intermittent real bug`);
    }
    return {
      category: 'TIMING',
      confidence: Math.min(0.9, 0.5 + 0.05 * runs),
      evidence: [{ source: this.id, message: `${rate} with ${distinctErrors} different errors`, data: { runs, failures, failureRate, distinctErrors } }],
    };
  },
};

/**
 * A value mismatch on a test that was reliable until it started failing the same way.
 * Declines when the server failed during the test: the wrong value may come from the
 * backend (ENV) or from a test that provokes errors on purpose, which only the LLM layer,
 * seeing the whole trace, can tell apart (rules-3).
 */
const realBugAssertion: Rule = {
  id: 'real-bug-assertion',
  evaluate({ record, history, loadFailedRequests }) {
    const mismatch = valueMismatch(record.errorMessage);
    if (!mismatch) return null;
    const { runs, failingStreak, streakDistinctErrors, failuresBeforeStreak, passesBeforeStreak } = history;
    const values = `expected ${truncate(mismatch.expected, 30)}, received ${truncate(mismatch.received, 30)}`;

    if (runs < 2) return declined(this.id, `value mismatch (${values}) on the test's first recorded run; no history to call it stable`);
    if (failingStreak === 0 || failuresBeforeStreak > 0) {
      return declined(this.id, `value mismatch (${values}), but the test has passed and failed on and off, so its history isn't stable`);
    }
    if (streakDistinctErrors > 1) {
      return declined(this.id, `value mismatch, but the error changed across the last ${failingStreak} failing runs (${streakDistinctErrors} variants)`);
    }
    const serverFailure = (loadFailedRequests?.() ?? []).find((r) => r.status !== null && r.status >= 500);
    if (serverFailure) {
      return declined(this.id, `value mismatch (${values}), but ${serverFailure.url} returned ${serverFailure.status} during the test: the backend may explain the wrong value`);
    }

    const message =
      passesBeforeStreak > 0
        ? `passed ${passesBeforeStreak} time(s), then failed the last ${failingStreak} run(s) with the same mismatch: ${values}`
        : `failed all ${failingStreak} recorded runs with the same mismatch: ${values}`;
    return {
      category: 'REAL_BUG',
      confidence: Math.min(0.9, 0.65 + 0.05 * failingStreak + (passesBeforeStreak >= 3 ? 0.05 : 0)),
      evidence: [{ source: this.id, message, data: { ...mismatch, failingStreak, passesBeforeStreak } }],
    };
  },
};

/**
 * Priority order: the first matching rule decides. Signals from outside the test (ENV)
 * come first, so a 5xx that also fails an assertion is ENV, not REAL_BUG.
 */
export const RULES: readonly Rule[] = [envMassFailure, envNetwork, testDataCollision, envServerError, locatorDriftStrict, timingRetryPass, locatorDrift, timingFlaky, realBugAssertion];
