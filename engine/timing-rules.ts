// TIMING rules: the failure is a race or an intermittent effect, not a deterministic break. Each
// reads a different signal - a retry that passed, a click something else intercepted, a test that
// keeps flipping or has flaked this way before - and all stay below the auto-fix threshold,
// because knowing a race happened does not say which wait to add.
import type { Rule, RuleOutcome } from './rules.ts';
import { driverClickIntercepted, driverStaleElement } from './driver-errors.ts';
import { errorShape, truncate } from './signature.ts';

export const FLAKY_MIN_RATE = 0.2;
export const FLAKY_MAX_RATE = 0.8;
export const TIMING_MIN_RUNS = 3;

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * Any request that failed during the test. Narrowing this to server errors and no-response was
 * measured and changed nothing on the labelled data, while it would stop a 401 (expired login)
 * from counting as the environment problem it is, so every failed request still counts.
 */
function dependencyFailure(load: (() => Array<{ url: string; status: number | null }>) | undefined) {
  return (load?.() ?? [])[0];
}

function declined(source: string, message: string, data?: Record<string, unknown>): RuleOutcome {
  return { category: null, confidence: 0, evidence: [{ source, message, data }] };
}

/**
 * The test failed but another attempt of the same code in the same run passed: Playwright's
 * own "flaky" signal. A deterministic cause (real bug, drifted locator) would fail every
 * attempt. Confidence stays below the auto-fix threshold: the rule knows a race happened,
 * not where. Network signals are handled first by env-network.
 */
export const timingRetryPass: Rule = {
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
export const timingFlaky: Rule = {
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
 * Playwright found the element, waited until it was visible, enabled and stable, and then the
 * click still could not land because another element was on top of it: an overlay, a toast or a
 * menu that had not gone away yet. That is a race in the page, not a broken feature and not a
 * renamed element. On every labelled dataset (32 cases across five projects) each failure with
 * this text is a TIMING failure. Confidence stays below the auto-fix line: the agent knows a
 * race happened, not which wait to add (rules-7).
 */
export const timingIntercepted: Rule = {
  id: 'timing-intercepted',
  evaluate({ record }) {
    const match = record.errorMessage.match(/<[^>]+>[^\n]*intercepts pointer events/);
    if (match) {
      const what = truncate(match[0].replace(/\s+/g, ' ').trim(), 100);
      return {
        category: 'TIMING',
        confidence: 0.8,
        evidence: [{ source: this.id, message: `the element was ready but the click could not land: ${what}, so something was still on top of it`, data: { intercepted: what } }],
      };
    }
    // Selenium and Cypress report the same race in their own words. No labelled data from those
    // tools has measured this yet, so the confidence stays below what the merge gate trusts.
    const other = driverClickIntercepted(record.errorMessage);
    if (!other) return null;
    const what = truncate(other.replace(/\s+/g, ' '), 100);
    return {
      category: 'TIMING',
      confidence: 0.65,
      evidence: [{ source: this.id, message: `the click could not land because ${what} was on top of the element, so something had not gone away yet`, data: { intercepted: what } }],
    };
  },
};

/**
 * Selenium's stale element (and Cypress's "the page updated while this command was executing"):
 * the test found the element, then the page re-rendered and replaced it before the test used it.
 * That is a race between the test and the page, fixed by finding the element again, not a broken
 * feature. Unmeasured on labelled data, so below the merge gate's trust line.
 */
export const timingStaleElement: Rule = {
  id: 'timing-stale-element',
  evaluate({ record }) {
    const stale = driverStaleElement(record.errorMessage);
    if (!stale) return null;
    return {
      category: 'TIMING',
      confidence: 0.65,
      evidence: [{ source: this.id, message: `"${truncate(stale, 80)}": the element was found, then the page replaced it before the test used it`, data: { stale } }],
    };
  },
};

/**
 * A known flaky test failing the way it flaked before: in an earlier run it failed with this same
 * error and then passed on a retry of the same code. This is the memory flaky-test products keep
 * (a test flagged once stays flagged). On the nine labelled datasets, every later failure of such
 * a test is TIMING or ENV, never a real bug or a renamed element, across five projects. Declines
 * when a request failed during the test, since a flaky dependency is ENV (rules-8).
 */
export const timingKnownFlaky: Rule = {
  id: 'timing-known-flaky',
  evaluate({ record, history, loadFailedRequests }) {
    const shape = errorShape(record.errorMessage);
    if (!history.earlierFlakeShapes.includes(shape)) return null;
    // A dependency failing during the test is checked first: that is ENV, whatever else holds.
    const failed = dependencyFailure(loadFailedRequests);
    if (failed) {
      return declined(this.id, `this test flaked before with this same error, and ${failed.url} failed during it (${failed.status ?? 'no response'}): a dependency failing now and then is an environment problem, not a race inside the test`);
    }
    // A regression can wear an old flake's error. Its signature is different, though: it fails every
    // retry on this commit while the test passes on other commits, where a flake usually passes one
    // of its retries. Found by code review: without this, the merge gate could let such a
    // regression through as "known flaky". Measured, most such failures are still the old flake, so
    // the category stays TIMING, but at a confidence below what the merge gate trusts: a person
    // looks before it can merge.
    const retried = history.sameCommitAttempts >= 2;
    if (retried && history.sameCommitFailures === history.sameCommitAttempts && history.passesOnOtherCommits > 0) {
      return {
        category: 'TIMING',
        confidence: 0.6,
        evidence: [
          {
            source: this.id,
            message: `a known flaky test failing its old way, but this time it failed all ${history.sameCommitAttempts} attempts on this commit while passing on other commits, which is also how a regression looks: a person should confirm`,
            data: { shape, regressionShaped: true },
          },
        ],
      };
    }
    return {
      category: 'TIMING',
      confidence: 0.75,
      evidence: [{ source: this.id, message: 'a known flaky test: in an earlier run it failed with this same error and then passed on a retry of the same code', data: { shape } }],
    };
  },
};

/** Flips between passing and failing needed before a test counts as intermittent, not broken. */
export const INTERMITTENT_MIN_ALTERNATIONS = 3;

/**
 * A test that keeps switching between passing and failing across commits. A change that breaks a
 * test flips it once and it stays broken; a race flips it again and again. The deterministic
 * rules above (drift on the page, data collisions, server errors) are checked first, so this only
 * catches what none of them explains. Confidence stays well below the auto-fix threshold: the
 * rule knows the failure is not deterministic, not where the race is (rules-6, from misreading
 * cross-branch flakes as real bugs on real CI data).
 */
export const timingIntermittent: Rule = {
  id: 'timing-intermittent',
  evaluate({ history, loadFailedRequests }) {
    const { alternations, runs, failures } = history;
    if (alternations < INTERMITTENT_MIN_ALTERNATIONS) return null;
    // A dependency that fails now and then also makes a test come and go, and that is ENV, not a
    // race in the test. Seen on held-out data, where an external media API broke this test.
    const failed = dependencyFailure(loadFailedRequests);
    if (failed) {
      return declined(this.id, `this test comes and goes on this branch (${alternations} switches in ${runs} runs) and ${failed.url} failed during it (${failed.status ?? 'no response'}): a dependency failing now and then is an environment problem, not a race inside the test`);
    }
    return {
      category: 'TIMING',
      confidence: 0.7,
      evidence: [
        {
          source: 'timing-intermittent',
          message: `this test switched between passing and failing ${alternations} times across the last ${runs} runs (${failures} failed): it comes and goes rather than staying broken`,
          data: { alternations, runs, failures },
        },
      ],
    };
  },
};
