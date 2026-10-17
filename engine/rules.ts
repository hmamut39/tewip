// The phase-2 rule set. Every rule is deterministic: same record + history → same answer.
// A rule returns null when it doesn't apply, or an outcome with category null when it
// looked and declined; the declined evidence tells phase 3 what was already ruled out.
import type { Evidence, RootCause, TriageRecord } from '../reporters/types.ts';
import { deviceEnvSignal } from './device-errors.ts';
import { INFRA_MEANING, infraSignal } from './infra-errors.ts';
import { isElementNotFound, networkSignal, valueMismatch } from './error-parse.ts';
import { locatorDrift, locatorDriftStrict } from './drift-rules.ts';
import { envMissingDependency } from './missing-dependency.ts';
import { timingFlaky, timingIntercepted, timingIntermittent, timingKnownFlaky, timingRetryPass, timingStaleElement } from './timing-rules.ts';
import type { RunContext, TestHistory } from './history.ts';
import { errorScenarioOf } from './llm/context.ts';
import { errorShape, truncate } from './signature.ts';
import type { SnapshotElement } from './snapshot.ts';

export const MASS_MIN_TESTS = 3;
export const MASS_MIN_SHARE = 0.3;
export { FLAKY_MAX_RATE, FLAKY_MIN_RATE, TIMING_MIN_RUNS } from './timing-rules.ts';
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

/**
 * A mobile run that failed because of the device, not the app: no emulator or simulator, the app
 * never installed or crashed on launch, the automation server unreachable, the test sandbox not
 * buildable. The same kind of answer as a refused connection, and as safe to act on: re-run it
 * somewhere healthy. Detox reports a crash and a test timeout with the same error, so the reader
 * declines the timeout case and this rule never sees it.
 */
/**
 * The machinery the test runs on broke, not the code: a container that never started, an image that
 * could not be pulled, a runner out of disk or memory, a taken port, a name that would not resolve.
 * Re-run it somewhere healthy. These words cannot come from an application's own assertion, which is
 * why they can be trusted deterministically.
 */
const envInfra: Rule = {
  id: 'env-infra',
  evaluate({ record }) {
    const signal = infraSignal(record.errorMessage);
    if (!signal) return null;
    return {
      category: 'ENV',
      confidence: signal.confidence,
      evidence: [{ source: this.id, message: `${INFRA_MEANING[signal.kind]}: "${truncate(signal.match, 80)}"`, data: { ...signal } }],
    };
  },
};

const envDevice: Rule = {
  id: 'env-device',
  evaluate({ record }) {
    const signal = deviceEnvSignal(record.errorMessage);
    if (!signal) return null;
    const what = { 'no-device': 'no device or simulator was available', 'app-crashed': 'the app under test was not running', 'install-failed': 'the app or test runner could not be installed', 'driver-unreachable': 'the automation server could not be reached', sandbox: 'the test sandbox could not be built' }[signal.kind];
    return {
      category: 'ENV',
      confidence: signal.confidence,
      evidence: [{ source: this.id, message: `${what}: "${truncate(signal.match, 80)}"`, data: { ...signal } }],
    };
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
    // A test that has never passed anywhere (often a new test for new code) gives no baseline: its
    // server error is as likely a bug in the new backend code as an environment problem. Found as
    // the one real bug the merge gate would have let through on the labelled data (rules-8).
    if (history.runs > 0 && history.failures >= history.runs) {
      return declined(this.id, `${what}, but this test has never passed (${history.failures} failures in ${history.runs} attempts), so the error may be a bug in new code`);
    }
    return { category: 'ENV', confidence: 0.7, evidence: [{ source: this.id, message: what, data: { ...failure } }] };
  },
};

/**
 * A value mismatch on a test that was reliable until it started failing the same way.
 * Declines when the server failed during the test: the wrong value may come from the
 * backend (ENV) or from a test that provokes errors on purpose, which only the LLM layer,
 * seeing the whole trace, can tell apart (rules-3).
 *
 * **Do not remove the history requirement.** Phase 64 found that `tewip bugs` files almost nothing
 * from one CI run - 1 ticket out of 1,964 real failures - because every test in a single run has
 * `runs < 2` and this rule declines. The proposed fix was to let a plain value mismatch stand on its
 * own: "expected 4, received 3 needs no model" is an obvious-sounding argument, and it was measured
 * in Phase 65 over **2,767 hand-labelled real failures from nine projects**:
 *
 *     293 value mismatches -> TIMING 265 (90.4%), REAL_BUG 26 (8.9%), ENV 2 (0.7%)
 *
 * Per project it is 0%, 0%, 0%, 4%, 5%, 6%, 7%, 11%, 39%. **A flaky test fails its assertion too -
 * that is what failing looks like.** The mismatch is not the signal; the history around it is, which
 * is what the streak conditions below are reading and what one CI run cannot supply. Re-derive with
 * `node eval/mismatch-precision.ts` before changing any of this.
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
export const RULES: readonly Rule[] = [envMissingDependency, envMassFailure, envNetwork, envInfra, envDevice, testDataCollision, envServerError, locatorDriftStrict, timingIntercepted, timingStaleElement, timingRetryPass, locatorDrift, timingFlaky, timingIntermittent, timingKnownFlaky, realBugAssertion];
