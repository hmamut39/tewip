// Phase 30: performance.
//
// Two facts below came from running k6 v2.3.0 against a real server, not from documentation, and
// both would have been wrong from memory:
//
//   - a classic summary writes `{"p(95)<120": true}` when the threshold is **breached**. It reads
//     like "the condition holds" and means the opposite. A run whose p95 was 282ms against a 120ms
//     threshold is the one that produced `true`;
//   - `--new-machine-readable-summary` records **no threshold results at all**, so "nothing was
//     breached" is not an answer that file can support.
//
// Everything else here tests the refusal. Four real runs of identical code produced p95 values of
// 60.8, 60.9, 62.8 and 61.4ms, so a 61.4ms run must not be called a regression against the first
// three. That restraint is the feature; calling a 4% wobble a regression is how the whole category
// of tool gets muted.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readK6Summary, requestCount } from '../perf/k6.ts';
import { compareMetric, ENOUGH_BASELINES, timingsToCompare } from '../perf/compare.ts';
import { baselineFor, knownLabels, recordRun, storedRuns } from '../perf/history.ts';
import { renderPerf } from '../perf/perf-command.ts';
import { fromK6 } from '../perf/run.ts';

/** The classic shape, as k6 writes it with --summary-export. */
function classic(p95: number, thresholdBreached: boolean, requests = 876) {
  return {
    metrics: {
      http_req_duration: {
        avg: p95 * 0.55,
        min: 4.7,
        med: p95 * 0.5,
        'p(90)': p95 * 0.95,
        'p(95)': p95,
        max: p95 * 2,
        thresholds: { 'p(95)<120': thresholdBreached },
      },
      http_req_failed: { passes: 0, fails: requests, value: 0, thresholds: { 'rate<0.01': false } },
      http_reqs: { count: requests, rate: 70 },
    },
  };
}

/** The new shape, as k6 writes it with --new-machine-readable-summary. */
function machineReadable(p95: number, requests = 867) {
  return {
    version: '1.0.0',
    metadata: { generated_at: '2026-10-11T10:00:00Z', k6_version: '2.3.0' },
    config: { script: "export const options = { thresholds: { http_req_duration: ['p(95)<120'] } };" },
    results: {
      metrics: [
        { name: 'http_req_duration', type: 'trend', contains: 'time', values: { avg: p95 * 0.55, min: 4.6, med: p95 * 0.5, p90: p95 * 0.95, p95, max: p95 * 2 } },
        { name: 'http_req_failed', type: 'rate', contains: 'default', values: { matches: 0, rate: 0, total: requests } },
        { name: 'http_reqs', type: 'counter', contains: 'default', values: { count: requests, rate: 70 } },
      ],
    },
  };
}

function summaryFile(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tewip-k6-')), 'summary.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

describe('reading a k6 summary', () => {
  it('true in a threshold entry means breached, not satisfied', () => {
    const held = readK6Summary(summaryFile(classic(62.5, false)));
    const broken = readK6Summary(summaryFile(classic(282.5, true)));
    assert.equal(held.thresholds?.find((t) => t.expression === 'p(95)<120')?.breached, false);
    assert.equal(broken.thresholds?.find((t) => t.expression === 'p(95)<120')?.breached, true);
  });

  it('reads both percentile spellings, because the two exports disagree', () => {
    assert.equal(readK6Summary(summaryFile(classic(62.5, false))).timings.http_req_duration.p95, 62.5);
    assert.equal(readK6Summary(summaryFile(machineReadable(62.3))).timings.http_req_duration.p95, 62.3);
  });

  it('the machine-readable export records no thresholds, which is not the same as none breached', () => {
    const run = readK6Summary(summaryFile(machineReadable(282.5)));
    assert.equal(run.thresholds, null, 'must be null, never an empty list');
    assert.equal(run.format, 'machine-readable');
  });

  it('counts the requests, so a verdict from a handful can be marked thin', () => {
    assert.equal(requestCount(readK6Summary(summaryFile(classic(62, false, 876)))), 876);
    assert.equal(requestCount(readK6Summary(summaryFile(machineReadable(62, 867)))), 867);
  });

  it('refuses a file that is not a k6 summary rather than reporting no regression', () => {
    assert.throws(() => readK6Summary(summaryFile({ suites: [], tests: 3 })), /not a k6 summary/);
  });
});

describe('what counts as slower', () => {
  // The real spread of four identical runs.
  const REAL_BASELINE = [60.9, 60.8, 62.8];

  it('says cannot say with nothing to compare against', () => {
    const c = compareMetric('http_req_duration', 62, []);
    assert.equal(c.direction, 'cannot-say');
    assert.match(c.why, /nothing to compare/);
  });

  it(`says cannot say below ${ENOUGH_BASELINES} baselines, however large the gap looks`, () => {
    for (const baseline of [[60.9], [60.9, 60.8]]) {
      const c = compareMetric('http_req_duration', 282.5, baseline);
      assert.equal(c.direction, 'cannot-say', `${baseline.length} baselines`);
      assert.match(c.why, /not enough to know what noise looks like/);
    }
  });

  it('does not call a fourth identical run a regression', () => {
    // 61.4ms, measured, against three real runs of the same code.
    const c = compareMetric('http_req_duration', 61.4, REAL_BASELINE);
    assert.equal(c.direction, 'cannot-say');
    assert.match(c.why, /within what 3 baseline runs already did/);
  });

  it('calls a real regression, and says by how much', () => {
    const c = compareMetric('http_req_duration', 282.5, REAL_BASELINE);
    assert.equal(c.direction, 'slower');
    assert.match(c.why, /\+364%|\+36\d%/);
    assert.equal(c.baselineLow, 60.8);
    assert.equal(c.baselineHigh, 62.8);
  });

  it('calls a real improvement too', () => {
    assert.equal(compareMetric('http_req_duration', 20, REAL_BASELINE).direction, 'faster');
  });

  it('a tiny move is never called, even when the baselines are suspiciously tight', () => {
    // Three identical runs give a spread of zero; without a floor, 50.1 against 50 would be a
    // regression. The floor is 5%.
    const identical = [50, 50, 50];
    assert.equal(compareMetric('http_req_duration', 50.1, identical).direction, 'cannot-say');
    assert.equal(compareMetric('http_req_duration', 51, identical).direction, 'cannot-say');
    assert.equal(compareMetric('http_req_duration', 60, identical).direction, 'slower');
  });

  it('compares the timings and leaves the tagged duplicates alone', () => {
    const run = readK6Summary(summaryFile(classic(62, false)));
    run.timings['http_req_duration{expected_response:true}'] = run.timings.http_req_duration;
    assert.deepEqual(timingsToCompare(run), ['http_req_duration']);
  });
});

describe('the baseline is only what was deliberately recorded', () => {
  const project = () => mkdtempSync(join(tmpdir(), 'tewip-perfhist-'));

  it('records and reads back, keeping labels apart', () => {
    const root = project();
    recordRun(root, 'checkout', fromK6(readK6Summary(summaryFile(classic(62, false))), 876));
    recordRun(root, 'search', fromK6(readK6Summary(summaryFile(classic(20, false))), 500));
    assert.equal(storedRuns(root, 'checkout').length, 1);
    assert.equal(storedRuns(root, 'search').length, 1);
    assert.deepEqual(baselineFor(storedRuns(root, 'checkout'), 'http_req_duration'), [62]);
    assert.deepEqual(knownLabels(root), ['checkout', 'search']);
  });

  it('a line it cannot read does not make the whole baseline unreadable', () => {
    const root = project();
    recordRun(root, 'x', fromK6(readK6Summary(summaryFile(classic(62, false))), 876));
    const path = join(root, '.tewip', 'perf', 'runs.jsonl');
    mkdirSync(join(root, '.tewip', 'perf'), { recursive: true });
    writeFileSync(path, `${'{ this is not json'}\n${JSON.stringify({ at: '2026-01-01', label: 'x', timings: { http_req_duration: { p95: 70, med: 30, avg: 30 } }, requests: 1 })}\n`, 'utf8');
    assert.equal(storedRuns(root, 'x').length, 1);
  });
});

describe('the report', () => {
  const run = (p95: number, breached: boolean, requests = 876) => fromK6(readK6Summary(summaryFile(classic(p95, breached, requests))), requests);

  it('never says a threshold held when the export does not record thresholds', () => {
    const r = fromK6(readK6Summary(summaryFile(machineReadable(282.5))), 867);
    const report = renderPerf(r, [], 'default', 5, false);
    assert.match(report, /Cannot say.*records no threshold results/s);
    assert.ok(!/No threshold breached/.test(report));
  });

  it('says what it does not know, every time', () => {
    const report = renderPerf(run(62, false), [], 'default', 5, false);
    assert.match(report, /What this does not tell you/);
    assert.match(report, /Nothing about production/);
    assert.match(report, /No duration is predicted/);
    assert.match(report, /Not capacity/);
  });

  it('warns when the run is too thin for a percentile to mean anything', () => {
    assert.match(renderPerf(run(62, false, 12), [], 'default', 5, false), /12 requests is thin/);
    assert.ok(!/is thin/.test(renderPerf(run(62, false), [], 'default', 5, false)));
  });

  it('explains that it did not record, so nobody assumes a baseline grew', () => {
    assert.match(renderPerf(run(62, false), [], 'default', 5, false), /was \*\*not\*\* recorded/);
    assert.match(renderPerf(run(62, false), [], 'default', 5, true), /was added to the baseline/);
  });

  it('counts one breached threshold in the singular', () => {
    const report = renderPerf(run(282, true), [], 'default', 5, false);
    assert.match(report, /\*\*1 of your own thresholds was breached\.\*\*/);
  });
});
