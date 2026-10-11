// Phase 31: one shape for "a run that can be compared to earlier runs".
//
// k6 and Lighthouse measure different things - k6 puts load on a server and reports percentiles
// over many requests, Lighthouse loads one page in one browser and reports what that load cost -
// but the question asked of both is identical: is this number outside what previous runs of the
// same thing produced? So they normalise to one shape and share one comparison, rather than Tewip
// growing a second, slightly different performance pipeline that drifts from the first.
//
// What does **not** normalise is how much evidence a run carries, and that is kept explicit.
// 876 requests and one page load are not the same weight of evidence, and the report says which it
// had.
import type { PerfRun, ThresholdResult } from './k6.ts';

export type Unit = 'ms' | 'score' | 'unitless';

export interface Metric {
  /** The one number worth comparing between runs. */
  value: number;
  unit: Unit;
  /**
   * How the tool that produced it rates this value on its own published scale, where it has one -
   * Lighthouse scores every metric 0 to 1. Null where the tool offers no opinion, as k6 does not.
   * Tewip never invents a band of its own: a "good" here is the tool's word, not Tewip's.
   */
  rating: 'good' | 'needs-improvement' | 'poor' | null;
}

export interface ComparableRun {
  source: 'k6' | 'lighthouse';
  at: string;
  /** Metric name to the number to compare. */
  metrics: Record<string, Metric>;
  /**
   * The thresholds the team themselves wrote, and whether each held. Null means this report does
   * not record them, which is not the same as none being breached and must never be collapsed into
   * it - see the note in k6.ts about the machine-readable export.
   */
  thresholds: ThresholdResult[] | null;
  /** How much the run actually did, which bounds what any of it can prove. */
  volume: { kind: 'request' | 'page load'; n: number };
}

/** k6's percentiles, reduced to the one number a comparison needs: p95. */
export function fromK6(run: PerfRun, requests: number): ComparableRun {
  const metrics: Record<string, Metric> = {};
  for (const [name, m] of Object.entries(run.timings)) {
    // Tagged duplicates (`http_req_duration{expected_response:true}`) are the same measurement
    // sliced, and comparing both says the same thing twice.
    if (name.includes('{')) continue;
    // k6 publishes no bands. It reports numbers and leaves "fast enough" to the team's thresholds,
    // which is the right division and the reason rating is null here.
    metrics[name] = { value: m.p95, unit: 'ms', rating: null };
  }
  return { source: 'k6', at: run.at, metrics, thresholds: run.thresholds, volume: { kind: 'request', n: requests } };
}

/** Metrics worth putting in front of a person, most important first. */
const ORDER = [
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'interaction-to-next-paint',
  'first-contentful-paint',
  'speed-index',
  'server-response-time',
  'http_req_duration',
];

export function metricsInOrder(run: ComparableRun): string[] {
  const names = Object.keys(run.metrics);
  const known = ORDER.filter((m) => names.includes(m));
  const rest = names.filter((m) => !ORDER.includes(m)).sort();
  return [...known, ...rest];
}

/** How a metric is written in a report: 2112ms, 0.08, 97. */
export function show(metric: Metric): string {
  if (metric.unit === 'ms') return `${Math.round(metric.value)}ms`;
  if (metric.unit === 'score') return `${Math.round(metric.value * 100)}`;
  return `${Math.round(metric.value * 1000) / 1000}`;
}
