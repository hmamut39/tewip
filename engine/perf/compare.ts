// Phase 30: deciding whether a run is actually slower.
//
// This is the whole phase. Reporting "p95 went from 180ms to 210ms, +16%" is trivial and worthless:
// nobody knows whether 16% is the change or the laptop. Performance numbers move between identical
// runs - a background process, a warm cache, a noisy CI runner - and a tool that calls every
// movement a regression gets muted within a week, which is the same failure mode as the
// accessibility scanners in Phase 28.
//
// So Tewip refuses unless it can tell the difference, and it can only tell the difference from
// **repeated baseline runs**. One run against one run says nothing, however large the gap looks,
// and Tewip says that rather than guessing. With three or more baselines there is an observed
// spread to compare against, and a change outside the baseline's own range by more than the width
// of that range is a change the runs themselves cannot explain.
//
// A k6 summary carries no raw samples - only avg, min, med, p90, p95, max - so a proper confidence
// interval is not available, and nothing here pretends otherwise. The test is deliberately crude
// and deliberately conservative: it is better to say "cannot say" to a real 4% regression than to
// cry wolf at noise, because the second one costs the team the tool.
import { MAIN_TIMING, type PerfRun } from './k6.ts';
import { show, type Unit } from './run.ts';

export type Direction = 'slower' | 'faster' | 'cannot-say';

export interface Comparison {
  metric: string;
  direction: Direction;
  /** The candidate run's value. */
  now: number;
  /** The middle of the baseline runs. */
  before: number;
  /** How many baseline runs were available. */
  baselineRuns: number;
  /** The lowest and highest the baseline itself reached. */
  baselineLow: number;
  baselineHigh: number;
  /** How far outside the baseline a value has to be before Tewip will call it. */
  margin: number;
  /** Why this verdict, in words a person can check against the numbers above. */
  why: string;
}

/** The fewest baseline runs from which run-to-run noise can be estimated at all. */
export const ENOUGH_BASELINES = 3;

/**
 * A change smaller than this is not called even when the baselines are unusually tight, because a
 * handful of identical runs can make the observed spread implausibly small and a 1% move is not
 * worth a person's afternoon.
 */
const SMALLEST_CHANGE = 0.05;

/**
 * The smallest difference in milliseconds this will call a regression, whatever the percentage.
 *
 * Found by running the same unchanged page four times through real Lighthouse and comparing the
 * fourth against the other three: **"1 metric is slower than the baseline runs can explain."** The
 * metric was `server-response-time`, the difference was **2.8ms on an 11ms baseline** - +25%, which
 * clears the 5% floor easily - and Lighthouse itself reports all four of those runs as *"Root
 * document took 10 ms"*. Tewip was claiming a regression at a precision finer than the tool it read
 * reports, on a page that had not changed.
 *
 * The number is not derived from theory and is not pretending to be: it sits between a false
 * positive this was measured producing (2.8ms) and the smallest true positive the suite already
 * requires it to catch (10ms on a 50ms baseline). A relative floor cannot separate those two - both
 * are about +20% - which is why the floor here is absolute.
 */
const MS_NOISE_FLOOR = 5;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const round = (n: number): number => Math.round(n * 10) / 10;

/**
 * Compares one metric of a candidate run against the same metric in the baseline runs.
 *
 * `baseline` is every stored value for the metric, oldest first. It is not averaged into a single
 * number, because its spread is the only evidence available about what noise looks like here.
 */
export function compareMetric(metric: string, now: number, baseline: number[], unit: Unit = 'ms'): Comparison {
  const runs = baseline.length;
  // Every number in `why` goes through the same formatter the rest of the report uses. These
  // sentences used to end "ms" whatever the metric was, so a Lighthouse score of 100 was explained
  // as **"1ms is within what 3 baseline runs already did on their own (1-1ms)"** - on the line
  // directly below one reading `performance-score 100`. Two different numbers and a unit that does
  // not exist, for the same measurement, in the same bullet.
  const u = (n: number) => show({ value: n, unit, rating: null });
  const before = runs > 0 ? median(baseline) : 0;
  const low = runs > 0 ? Math.min(...baseline) : 0;
  const high = runs > 0 ? Math.max(...baseline) : 0;
  const spread = high - low;
  const margin = Math.max(spread, before * SMALLEST_CHANGE, unit === 'ms' ? MS_NOISE_FLOOR : 0);
  const base = {
    metric,
    now: round(now),
    before: round(before),
    baselineRuns: runs,
    baselineLow: round(low),
    baselineHigh: round(high),
    margin: round(margin),
  };

  if (runs < ENOUGH_BASELINES) {
    return {
      ...base,
      direction: 'cannot-say',
      why:
        runs === 0
          ? 'there is nothing to compare this against yet'
          : `${runs} baseline ${runs === 1 ? 'run is' : 'runs are'} not enough to know what noise looks like here; ` +
            `Tewip needs ${ENOUGH_BASELINES}. Two runs can differ by this much for reasons that have nothing to do with the code.`,
    };
  }

  const percent = before > 0 ? Math.round(((now - before) / before) * 100) : 0;
  if (now > high + margin) {
    return {
      ...base,
      direction: 'slower',
      why:
        `${u(now)} is outside everything ${runs} baseline runs produced (${u(low)}-${u(high)}) ` +
        `by more than their own spread, so the runs cannot explain it. That is ${percent > 0 ? '+' : ''}${percent}% on the middle run.`,
    };
  }
  if (now < low - margin) {
    return {
      ...base,
      direction: 'faster',
      why: `${u(now)} is below everything ${runs} baseline runs produced (${u(low)}-${u(high)}) by more than their own spread.`,
    };
  }
  return {
    ...base,
    direction: 'cannot-say',
    why:
      `${u(now)} is within what ${runs} baseline runs already did on their own (${u(low)}-${u(high)}, ` +
      `allowing ${u(margin)} either side). A difference the baseline runs produce by themselves is not evidence about this change.`,
  };
}

export interface PerfVerdict {
  /** One per timing metric compared. */
  comparisons: Comparison[];
  /** The team's own thresholds, or null when the export does not record them. */
  thresholds: PerfRun['thresholds'];
  /** Requests in the candidate run: too few and nothing here is worth reading. */
  requests: number;
  /** True when something got slower by more than the baselines can explain. */
  regressed: boolean;
  /** True when a threshold the team wrote was breached. */
  breached: boolean;
}

/** Enough requests for a percentile to mean anything. Below this, p95 is three data points. */
export const ENOUGH_REQUESTS = 100;

/** Timings worth comparing, in the order a person would want them. */
export function timingsToCompare(run: PerfRun): string[] {
  const named = Object.keys(run.timings).filter((m) => !m.includes('{'));
  const first = named.filter((m) => m === MAIN_TIMING);
  const rest = named.filter((m) => m !== MAIN_TIMING && /duration|waiting|blocked/.test(m)).sort();
  return [...first, ...rest];
}
