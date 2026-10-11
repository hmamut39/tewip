// Phase 30: reading a k6 run.
//
// k6 writes two different summary shapes and Tewip reads both, because which one a team has depends
// on a flag they probably did not choose deliberately:
//
//   --summary-export                     the classic shape: metrics as a map, percentiles keyed
//                                        "p(95)", and - the part that matters - the result of every
//                                        threshold the team wrote.
//   --new-machine-readable-summary       metrics as an array, percentiles keyed p95, and **no
//                                        threshold results at all**.
//
// Both facts below were established by running k6 v2.3.0 against a real server rather than read
// from documentation, and both would have been got wrong from memory:
//
//  1. In the classic shape a threshold entry is `{"p(95)<120": true}` where **true means breached**.
//     It reads like "the condition holds". It means the opposite. A run whose p95 was 282ms against
//     a 120ms threshold is the one that produced `true`.
//  2. The machine-readable shape drops thresholds entirely. The word appears in the file only inside
//     `config.script`, which is the source text of the test. So a team on that flag has no pass or
//     fail recorded anywhere in their export, and Tewip has to say so rather than report "no
//     threshold was breached", which would be a lie of omission.
import { readFileSync } from 'node:fs';

export interface Measurement {
  /** `http_req_duration`, `iteration_duration`. */
  metric: string;
  avg: number;
  min: number;
  med: number;
  p90: number;
  p95: number;
  max: number;
}

export interface ThresholdResult {
  metric: string;
  /** The team's own expression, as they wrote it: `p(95)<120`. */
  expression: string;
  breached: boolean;
}

export interface PerfRun {
  tool: 'k6';
  /** Which export this came from, because one of them cannot answer about thresholds. */
  format: 'classic' | 'machine-readable';
  at: string;
  /** Trend metrics: the timings. */
  timings: Record<string, Measurement>;
  /** Rate metrics, chiefly http_req_failed. */
  rates: Record<string, { rate: number; total: number }>;
  /** Counter metrics: how much work the run did, which bounds what it can prove. */
  counts: Record<string, number>;
  /**
   * The team's thresholds and whether each held - or **null**, meaning this export does not record
   * them. Null and "none were breached" are different answers and must never be collapsed.
   */
  thresholds: ThresholdResult[] | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function measurement(metric: string, values: Record<string, unknown>): Measurement {
  return {
    metric,
    avg: num(values.avg),
    min: num(values.min),
    med: num(values.med),
    // The two shapes disagree on how a percentile is spelled.
    p90: num(values['p(90)'] ?? values.p90),
    p95: num(values['p(95)'] ?? values.p95),
    max: num(values.max),
  };
}

/** A trend metric is one with a median: a timing, rather than a counter or a rate. */
const isTrend = (v: Record<string, unknown>): boolean => 'med' in v || 'p(95)' in v || 'p95' in v;

function classic(parsed: Record<string, unknown>, at: string): PerfRun {
  const metrics = (parsed.metrics ?? {}) as Record<string, Record<string, unknown>>;
  const run: PerfRun = { tool: 'k6', format: 'classic', at, timings: {}, rates: {}, counts: {}, thresholds: [] };

  for (const [name, values] of Object.entries(metrics)) {
    if (typeof values !== 'object' || values === null) continue;

    for (const [expression, breached] of Object.entries((values.thresholds ?? {}) as Record<string, unknown>)) {
      // `true` is a breach. See the note at the top: this is the opposite of how it reads.
      run.thresholds!.push({ metric: name, expression, breached: breached === true });
    }

    if (isTrend(values)) run.timings[name] = measurement(name, values);
    else if ('rate' in values || ('passes' in values && 'fails' in values)) {
      const passes = num(values.passes);
      const fails = num(values.fails);
      run.rates[name] = { rate: num(values.rate ?? values.value), total: passes + fails };
    } else if ('count' in values) run.counts[name] = num(values.count);
  }
  return run;
}

interface NewMetric {
  name?: unknown;
  type?: unknown;
  values?: unknown;
}

function machineReadable(parsed: Record<string, unknown>, at: string): PerfRun {
  const results = (parsed.results ?? {}) as Record<string, unknown>;
  const metrics = Array.isArray(results.metrics) ? (results.metrics as NewMetric[]) : [];
  // Not an empty list: this export records no threshold results, which is a different statement.
  const run: PerfRun = { tool: 'k6', format: 'machine-readable', at, timings: {}, rates: {}, counts: {}, thresholds: null };

  for (const entry of metrics) {
    const name = typeof entry.name === 'string' ? entry.name : '';
    const values = (entry.values ?? {}) as Record<string, unknown>;
    if (name === '' || typeof values !== 'object' || values === null) continue;
    if (entry.type === 'trend') run.timings[name] = measurement(name, values);
    else if (entry.type === 'rate') run.rates[name] = { rate: num(values.rate), total: num(values.total) };
    else if (entry.type === 'counter' || 'count' in values) run.counts[name] = num(values.count);
  }
  return run;
}

/** True of either shape k6 writes. */
function looksLikeK6Summary(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.metrics === 'object' && o.metrics !== null && !Array.isArray(o.metrics)) return true;
  const results = o.results as Record<string, unknown> | undefined;
  return typeof results === 'object' && results !== null && Array.isArray(results.metrics);
}

export function readK6Summary(path: string): PerfRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not JSON. Tewip reads the JSON k6 writes with --summary-export.`);
  }
  if (!looksLikeK6Summary(parsed)) {
    throw new Error(
      `${path} is JSON, but not a k6 summary: Tewip looked for a "metrics" object or a "results.metrics" array. ` +
        'Write one with: k6 run --summary-export=summary.json your-test.js',
    );
  }
  const o = parsed as Record<string, unknown>;
  const metadata = (o.metadata ?? {}) as Record<string, unknown>;
  const at = typeof metadata.generated_at === 'string' ? metadata.generated_at : new Date().toISOString();
  return Array.isArray((o.results as Record<string, unknown> | undefined)?.metrics) ? machineReadable(o, at) : classic(o, at);
}

/** The metric a team means by "how slow is it", when they have not said which. */
export const MAIN_TIMING = 'http_req_duration';

/** How much work the run did. A verdict from a handful of requests is not worth printing. */
export function requestCount(run: PerfRun): number {
  return run.counts.http_reqs ?? run.rates.http_req_failed?.total ?? run.counts.iterations ?? 0;
}
