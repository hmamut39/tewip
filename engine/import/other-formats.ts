// Report formats that are not JUnit XML and not TRX: Robot Framework's output.xml, JMeter's .jtl,
// and k6's summary JSON.
//
// Appium is deliberately absent: an Appium suite reports through Mocha, pytest or JUnit, which
// Tewip already reads, and its failures ("An unknown server-side error occurred", "Could not find a
// connected device") are already understood by the device and driver readers. Adding an "Appium
// importer" would be a label on something that already works.
import type { XmlElement } from './xml.ts';
import { descendants } from './xml.ts';

export interface RawCase {
  testId: string;
  file: string;
  duration: number;
  attempts: Array<{ failed: boolean; message: string; stack: string }>;
}

const text = (element: XmlElement | undefined): string => (element ? element.text.trim() : '');

/**
 * Robot Framework writes output.xml by default, and only writes JUnit if asked. A suite holds
 * tests, a test holds a status with the failure message inside it, and suites nest - so the test's
 * name is its whole path, the way Robot itself prints it.
 */
export function robotCases(root: XmlElement): RawCase[] {
  const cases: RawCase[] = [];
  const walk = (element: XmlElement, path: string[], source: string) => {
    for (const child of element.children) {
      if (child.name === 'suite') {
        walk(child, [...path, child.attrs.name ?? ''], child.attrs.source ?? source);
        continue;
      }
      if (child.name !== 'test') continue;
      const status = child.children.find((c) => c.name === 'status');
      const failed = (status?.attrs.status ?? '').toUpperCase() === 'FAIL';
      const start = status?.attrs.starttime ?? status?.attrs.start ?? '';
      const end = status?.attrs.endtime ?? status?.attrs.end ?? '';
      // The last keyword that failed says where it went wrong, which the message alone does not.
      const failedKeyword = descendants(child, 'kw').find((kw) => (kw.children.find((c) => c.name === 'status')?.attrs.status ?? '').toUpperCase() === 'FAIL');
      const where = failedKeyword?.attrs.name ? `Keyword: ${failedKeyword.attrs.name}` : '';
      cases.push({
        testId: [...path, child.attrs.name ?? ''].filter(Boolean).join(' > '),
        file: source,
        duration: robotDuration(start, end),
        attempts: [{ failed, message: failed ? text(status) || 'the test failed' : '', stack: failed ? where : '' }],
      });
    }
  };
  walk(root, [], root.attrs.source ?? '');
  return cases;
}

/** Robot's timestamp as an ISO one, or '' when it is not the shape Robot writes. */
export function robotTime(stamp: string): string {
  const at = robotStamp(stamp);
  return at > 0 ? new Date(at).toISOString() : '';
}

/** Robot's own timestamp shape: 20260923 14:05:01.123 */
function robotStamp(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(s.trim());
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])) : 0;
}

function robotDuration(start: string, end: string): number {
  const from = robotStamp(start);
  const to = robotStamp(end);
  return from > 0 && to >= from ? to - from : 0;
}

/**
 * JMeter's .jtl in XML form: one sample per request, s="false" when it failed. A load test has
 * thousands of samples, so they are grouped by label - nobody wants ten thousand records, they want
 * "the checkout request failed 412 times, mostly 503".
 */
export function jmeterCases(root: XmlElement): RawCase[] {
  const samples = [...descendants(root, 'httpSample'), ...descendants(root, 'sample')];
  const byLabel = new Map<string, { failed: number; total: number; time: number; codes: Map<string, number>; messages: Set<string> }>();
  for (const sample of samples) {
    const label = sample.attrs.lb ?? 'sample';
    const found = byLabel.get(label) ?? { failed: 0, total: 0, time: 0, codes: new Map(), messages: new Set() };
    found.total++;
    found.time += Number(sample.attrs.t ?? 0);
    if ((sample.attrs.s ?? 'true').toLowerCase() === 'false') {
      found.failed++;
      const code = `${sample.attrs.rc ?? ''} ${sample.attrs.rm ?? ''}`.trim();
      if (code) found.codes.set(code, (found.codes.get(code) ?? 0) + 1);
      const assertion = descendants(sample, 'failureMessage')[0];
      if (assertion) found.messages.add(text(assertion).slice(0, 200));
    }
    byLabel.set(label, found);
  }

  return [...byLabel].map(([label, s]) => {
    const worst = [...s.codes].sort((a, b) => b[1] - a[1])[0];
    // A 2xx that still counts as failed is an assertion failing, not the server: "mostly 200" would
    // read as nonsense to whoever opens the report.
    const why = worst ? (/^2\d\d/.test(worst[0]) ? `, an assertion failed (${worst[1]} times, response ${worst[0]})` : `, mostly ${worst[0]} (${worst[1]} times)`) : '';
    const message = s.failed === 0 ? '' : `${s.failed} of ${s.total} requests failed${why}${s.messages.size > 0 ? `: ${[...s.messages][0]}` : ''}`;
    return { testId: `JMeter > ${label}`, file: '', duration: s.time, attempts: [{ failed: s.failed > 0, message, stack: [...s.messages].join('\n').slice(0, 2000) }] };
  });
}

/**
 * k6 writes a summary as JSON (`k6 run --summary-export=summary.json`). A performance run does not
 * fail test by test: it fails when a threshold is crossed, and that is what is imported - one
 * record per crossed threshold, saying by how much.
 */
export function k6Cases(json: unknown): RawCase[] {
  const report = json as { metrics?: Record<string, any>; root_group?: unknown };
  if (!report?.metrics) return [];
  const cases: RawCase[] = [];
  for (const [metric, body] of Object.entries(report.metrics)) {
    const thresholds = (body as any).thresholds as Record<string, any> | undefined;
    if (!thresholds) continue;
    for (const [expression, result] of Object.entries(thresholds)) {
      // k6 writes either a boolean "ok" or an object with it; a crossed threshold is ok === false.
      const ok = typeof result === 'boolean' ? result : Boolean((result as any)?.ok);
      const measured = describeMetric(((body as any).values ?? body) as Record<string, number>);
      cases.push({
        testId: `k6 > ${metric} > ${expression}`,
        file: '',
        duration: 0,
        attempts: [{ failed: !ok, message: ok ? '' : `the threshold "${expression}" on ${metric} was crossed${measured ? `: ${measured}` : ''}`, stack: measured }],
      });
    }
  }
  return cases;
}

/** The numbers k6 reports for a metric, in one readable line. */
function describeMetric(body: Record<string, any>): string {
  const wanted = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'rate', 'count', 'value'];
  return wanted
    .filter((key) => typeof body[key] === 'number')
    .map((key) => `${key}=${round(body[key] as number)}`)
    .join(' ');
}

const round = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Whether a parsed JSON file looks like a k6 summary, so nothing else is read as one. */
export function looksLikeK6(json: unknown): boolean {
  const report = json as { metrics?: Record<string, unknown> };
  if (!report?.metrics || typeof report.metrics !== 'object') return false;
  return ['http_req_duration', 'iterations', 'vus', 'checks', 'http_reqs'].some((m) => m in report.metrics!);
}
