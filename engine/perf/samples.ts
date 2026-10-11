// Phase 39: comparing two sets of response times properly, because a .jtl gives real samples.
//
// Phase 30 had to be crude. A k6 summary carries six aggregates per metric and no samples, so the
// only honest test available was "is this value outside everything the baselines produced, by more
// than the width of their own spread". That refuses a lot of real regressions, which was the right
// trade when nothing better was possible.
//
// A JMeter .jtl carries one row per request, so something better *is* possible: a Mann-Whitney U
// test, which asks whether one distribution is shifted from another without assuming either is
// normal - and response times are never normal. They are a lump near the median with a long tail,
// which is exactly the shape a t-test handles badly.
//
// The decision that matters most here is **not** the p-value. With ten thousand samples a one
// millisecond shift is overwhelmingly significant and completely irrelevant, and a tool that
// reports it as a regression has taught its team that regressions are noise. So a change has to be
// both statistically real and large enough to care about, and the report says which of the two it
// failed when it fails.

/** How two sets of response times differ. */
export interface SampleVerdict {
  direction: 'slower' | 'faster' | 'cannot-say';
  /** Median now and before, in milliseconds. */
  now: number;
  before: number;
  /** How likely a random request now is slower than a random request before: 0.5 means no shift. */
  slowerThanBefore: number;
  /** The chance of seeing a shift this big if nothing changed. Null when the test could not run. */
  p: number | null;
  sampleSize: { now: number; before: number };
  why: string;
}

/** Below this per side the normal approximation is unreliable, so no test is claimed. */
export const ENOUGH_SAMPLES = 20;

/** A shift smaller than this is not worth a person's attention, however certain it is. */
const SMALLEST_SHIFT = 0.05;
const SMALLEST_SHIFT_MS = 2;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The Mann-Whitney U statistic, with the tie correction.
 *
 * Ties matter here rather than being a formality: response times are milliseconds rounded to
 * integers, so a fast endpoint produces hundreds of identical values and the uncorrected variance
 * would be wrong in the direction that invents significance.
 */
export function mannWhitney(a: number[], b: number[]): { u: number; z: number; p: number } | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return null;

  const all = [...a.map((v) => ({ v, from: 0 })), ...b.map((v) => ({ v, from: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  const tieGroups: number[] = [];
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j += 1;
    // Everything in a tie shares the average of the ranks they span.
    const shared = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = shared;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }

  let rankSumA = 0;
  for (const [i, entry] of all.entries()) if (entry.from === 0) rankSumA += ranks[i];

  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const mean = (n1 * n2) / 2;
  const tieTerm = tieGroups.reduce((sum, t) => sum + (t * t * t - t), 0);
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return { u: u1, z: 0, p: 1 };

  // Continuity-corrected, two-sided.
  const z = (u1 - mean - Math.sign(u1 - mean) * 0.5) / Math.sqrt(variance);
  return { u: u1, z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** The standard normal CDF, by Abramowitz and Stegun 26.2.17 - accurate to about 1e-7. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - d * poly;
}

/**
 * Whether this run is slower than the baseline, from the samples themselves.
 *
 * Both conditions have to hold. A difference that is not statistically real might be the machine;
 * a difference that is real but tiny is not worth anybody's afternoon, and reporting it is how a
 * team learns to ignore the report. The verdict says which one was missing.
 */
export function compareSamples(now: number[], before: number[]): SampleVerdict {
  const base = {
    now: Math.round(median(now) * 10) / 10,
    before: Math.round(median(before) * 10) / 10,
    sampleSize: { now: now.length, before: before.length },
  };

  if (now.length < ENOUGH_SAMPLES || before.length < ENOUGH_SAMPLES) {
    return {
      ...base,
      direction: 'cannot-say',
      slowerThanBefore: 0.5,
      p: null,
      why:
        `${now.length} requests now and ${before.length} before. Below ${ENOUGH_SAMPLES} on either side the test ` +
        'is not reliable, so Tewip will not run it. Lengthen the run rather than reading the numbers.',
    };
  }

  const test = mannWhitney(now, before);
  if (test === null) return { ...base, direction: 'cannot-say', slowerThanBefore: 0.5, p: null, why: 'there was nothing to compare' };

  // U is the count of (now, before) pairs where now ranks higher, so U / (n1*n2) is directly the
  // probability that a random request now is slower than a random one before. It is the most
  // readable effect size there is, and it needs no units.
  const slowerThanBefore = test.u / (now.length * before.length);
  const shift = base.before > 0 ? (base.now - base.before) / base.before : 0;
  const bigEnough = Math.abs(shift) >= SMALLEST_SHIFT && Math.abs(base.now - base.before) >= SMALLEST_SHIFT_MS;
  const real = test.p < 0.01;
  const percent = Math.round(shift * 100);
  const chance = Math.round(slowerThanBefore * 100);

  if (real && bigEnough) {
    const faster = base.now < base.before;
    return {
      ...base,
      direction: faster ? 'faster' : 'slower',
      slowerThanBefore,
      p: test.p,
      why:
        `the median moved from ${base.before}ms to ${base.now}ms (${percent > 0 ? '+' : ''}${percent}%), and a random ` +
        `request now is ${chance}% likely to be ${faster ? 'faster' : 'slower'} than a random one before. ` +
        `Over ${now.length} and ${before.length} requests that is not the machine (p < 0.01).`,
    };
  }
  if (real) {
    return {
      ...base,
      direction: 'cannot-say',
      slowerThanBefore,
      p: test.p,
      why:
        `the difference is real but too small to act on: ${base.before}ms to ${base.now}ms, ` +
        `${percent > 0 ? '+' : ''}${percent}%. With this many samples even a millisecond is statistically certain, ` +
        'which is why certainty alone is not the test.',
    };
  }
  return {
    ...base,
    direction: 'cannot-say',
    slowerThanBefore,
    p: test.p,
    why:
      `${base.before}ms to ${base.now}ms is within what these two runs could produce by themselves ` +
      `(p = ${test.p.toFixed(2)}). A difference the runs make on their own is not evidence about this change.`,
  };
}
