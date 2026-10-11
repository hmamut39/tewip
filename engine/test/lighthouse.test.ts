// Phase 31: reading a Lighthouse report.
//
// The shapes here were taken from real Lighthouse 13.5.0 output, produced by running it against a
// real page served locally, not written from documentation. The numbers in the comparison tests are
// also real: four Lighthouse runs of an unchanged page gave LCP of 922, 912, 936 and 916ms, and a
// deliberately slowed server gave 2112ms. So 916ms must not be called a regression against the
// first three, and 2112ms must be.
//
// The other thing under test is that Tewip does not invent a standard. "Is 2112ms bad?" is answered
// by Lighthouse's own score, which it computes on its own published curve - never by thresholds
// Tewip remembered and hard-coded.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isLighthouseFile, readLighthouse } from '../perf/lighthouse.ts';
import { compareMetric } from '../perf/compare.ts';
import { fromSameTool, recordRun, storedRuns, baselineFor } from '../perf/history.ts';
import { metricsInOrder, show } from '../perf/run.ts';
import { renderPerf } from '../perf/perf-command.ts';

function audit(id: string, score: number | null, numericValue?: number, mode = 'binary', items: unknown[] = []) {
  return {
    id,
    title: `${id} title`,
    score,
    scoreDisplayMode: mode,
    ...(numericValue === undefined ? {} : { numericValue, numericUnit: 'millisecond' }),
    ...(items.length > 0 ? { details: { type: 'table', items } } : {}),
  };
}

function node(selector: string, snippet: string, explanation: string) {
  return { node: { type: 'node', selector, snippet, explanation, nodeLabel: selector } };
}

function report(opts: { lcp?: number; cls?: number; perfScore?: number; a11y?: unknown[]; runtimeError?: unknown } = {}) {
  const a11yAudits = opts.a11y ?? [];
  const audits: Record<string, unknown> = {
    'largest-contentful-paint': audit('largest-contentful-paint', 1, opts.lcp ?? 922),
    'first-contentful-paint': audit('first-contentful-paint', 1, opts.lcp ?? 922),
    'cumulative-layout-shift': { id: 'cumulative-layout-shift', title: 'CLS', score: 1, scoreDisplayMode: 'numeric', numericValue: opts.cls ?? 0, numericUnit: 'unitless' },
    'server-response-time': audit('server-response-time', 0.2, 611),
  };
  for (const a of a11yAudits) audits[(a as { id: string }).id] = a;
  return {
    lighthouseVersion: '13.5.0',
    fetchTime: '2026-10-11T12:00:00.000Z',
    finalDisplayedUrl: 'http://127.0.0.1:8732/',
    ...(opts.runtimeError ? { runtimeError: opts.runtimeError } : {}),
    audits,
    categories: {
      performance: { score: opts.perfScore ?? 1, auditRefs: [] },
      accessibility: { score: 0.98, auditRefs: a11yAudits.map((a) => ({ id: (a as { id: string }).id })) },
    },
  };
}

function file(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tewip-lh-')), 'lh.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

describe('reading a Lighthouse report', () => {
  it('reads the metrics with their units', () => {
    const r = readLighthouse(file(report({ lcp: 2112, cls: 0.08 })));
    assert.equal(r.run.source, 'lighthouse');
    assert.equal(r.run.metrics['largest-contentful-paint'].value, 2112);
    assert.equal(r.run.metrics['largest-contentful-paint'].unit, 'ms');
    assert.equal(r.run.metrics['cumulative-layout-shift'].unit, 'unitless');
    assert.equal(r.lighthouseVersion, '13.5.0');
    assert.equal(r.url, 'http://127.0.0.1:8732/');
  });

  it("the band comes from Lighthouse's own score, not from numbers Tewip chose", () => {
    const r = readLighthouse(file(report()));
    // server-response-time scored 0.2 by Lighthouse, so it is poor however many ms it is.
    assert.equal(r.run.metrics['server-response-time'].rating, 'poor');
    assert.equal(r.run.metrics['largest-contentful-paint'].rating, 'good');
  });

  it('one page load is recorded as exactly that, not as a sample', () => {
    const r = readLighthouse(file(report()));
    assert.deepEqual(r.run.volume, { kind: 'page load', n: 1 });
  });

  it('an audit Lighthouse refuses to score is a question, never a pass', () => {
    const r = readLighthouse(
      file(report({ a11y: [audit('logical-tab-order', null, undefined, 'manual'), audit('focus-traps', null, undefined, 'manual')] })),
    );
    assert.deepEqual(r.manual.map((m) => m.id), ['logical-tab-order', 'focus-traps']);
    assert.equal(r.accessibilityFailures.length, 0, 'a manual check is not a failure');
  });

  it('a failing accessibility audit keeps the element it is about', () => {
    const r = readLighthouse(
      file(
        report({
          a11y: [audit('landmark-one-main', 0, undefined, 'binary', [node('html', '<html lang="en">', 'Fix all of the following:\n  Document does not have a main landmark')])],
        }),
      ),
    );
    assert.equal(r.accessibilityFailures.length, 1);
    assert.equal(r.accessibilityFailures[0].id, 'landmark-one-main');
    assert.equal(r.accessibilityFailures[0].selector, 'html');
    assert.equal(r.accessibilityFailures[0].explanation, 'Document does not have a main landmark');
  });

  it('a run that did not complete throws, rather than reporting no regression', () => {
    assert.throws(
      () => readLighthouse(file(report({ runtimeError: { code: 'NO_FCP', message: 'The page did not paint any content.' } }))),
      /did not complete.*did not paint/s,
    );
  });

  it('refuses a file that is not a Lighthouse report', () => {
    assert.throws(() => readLighthouse(file({ metrics: { http_req_duration: {} } })), /not a Lighthouse report/);
    assert.equal(isLighthouseFile(file({ metrics: {} })), false);
    assert.equal(isLighthouseFile(file(report())), true);
  });

  it('puts the metrics a person cares about first', () => {
    const order = metricsInOrder(readLighthouse(file(report())).run);
    assert.equal(order[0], 'largest-contentful-paint');
    assert.ok(order.indexOf('cumulative-layout-shift') < order.indexOf('server-response-time'));
  });

  it('shows each unit the way a person writes it', () => {
    assert.equal(show({ value: 2111.5, unit: 'ms', rating: null }), '2112ms');
    assert.equal(show({ value: 0.97, unit: 'score', rating: null }), '97');
    assert.equal(show({ value: 0.0824, unit: 'unitless', rating: null }), '0.082');
  });
});

describe('comparing Lighthouse runs', () => {
  // Measured: four runs of a page that did not change.
  const REAL = [922.2, 912.1, 936];

  it('does not call a fourth identical run a regression', () => {
    assert.equal(compareMetric('largest-contentful-paint', 916, REAL).direction, 'cannot-say');
  });

  it('calls the slowed page a regression', () => {
    const c = compareMetric('largest-contentful-paint', 2111.5, REAL);
    assert.equal(c.direction, 'slower');
    assert.match(c.why, /\+12\d%/);
  });

  it('a k6 run and a Lighthouse run are not each other baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-mix-'));
    const lh = readLighthouse(file(report())).run;
    recordRun(root, 'home', lh);
    recordRun(root, 'home', { source: 'k6', at: '2026-10-11T00:00:00Z', metrics: { http_req_duration: { value: 62, unit: 'ms', rating: null } }, thresholds: [], volume: { kind: 'request', n: 876 } });

    const all = storedRuns(root, 'home');
    assert.equal(all.length, 2);
    assert.equal(fromSameTool(all, 'lighthouse').length, 1);
    assert.equal(fromSameTool(all, 'k6').length, 1);
    assert.deepEqual(baselineFor(fromSameTool(all, 'k6'), 'http_req_duration'), [62]);
  });

  it('a baseline recorded by an older version is still read', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-old-'));
    mkdirSync(join(root, '.tewip', 'perf'), { recursive: true });
    writeFileSync(
      join(root, '.tewip', 'perf', 'runs.jsonl'),
      `${JSON.stringify({ at: '2026-10-10T00:00:00Z', label: 'old', timings: { http_req_duration: { p95: 61, med: 31, avg: 34 } }, requests: 876 })}\n`,
      'utf8',
    );
    const runs = storedRuns(root, 'old');
    assert.equal(runs.length, 1, 'an older run must not vanish and drop the count below three');
    assert.deepEqual(baselineFor(runs, 'http_req_duration'), [61]);
    assert.equal(fromSameTool(runs, 'k6').length, 1, 'a run with no source recorded was k6');
  });
});

describe('the Lighthouse report Tewip writes', () => {
  it('says the band is Lighthouse’s, and names the manual checks as neither pass nor fail', () => {
    const r = readLighthouse(file(report({ a11y: [audit('logical-tab-order', null, undefined, 'manual')] })));
    const out = renderPerf(r.run, [], 'home', 5, false, r.manual);
    assert.match(out, /Rated by Lighthouse's own scoring, not by any threshold Tewip invented/);
    assert.match(out, /1 accessibility checks Lighthouse refuses to score/);
    assert.match(out, /One page load/);
  });

  it('still says what it does not know', () => {
    const out = renderPerf(readLighthouse(file(report())).run, [], 'home', 5, false);
    assert.match(out, /Nothing about production/);
    assert.match(out, /Not capacity/);
  });
});
