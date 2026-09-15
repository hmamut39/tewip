// Unit tests for the rule engine on hand-built records. These check that each rule does
// what it claims; they say nothing about accuracy on real CI failures.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { diagnose } from '../engine.ts';
import { HistoryIndex } from '../history.ts';
import type { SnapshotElement } from '../snapshot.ts';
import { extractPageSnapshot } from '../snapshot.ts';

const NOT_FOUND = (locator: string) => `TimeoutError: locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for ${locator}\n`;
const MISMATCH = (expected: string, received: string) =>
  `Error: expect(locator).toHaveText(expected) failed\n\nLocator:  locator('#price')\nExpected: "${expected}"\nReceived: "${received}"\nTimeout:  2000ms\n\nCall log:\n  - waiting for locator('#price')\n    9 × locator resolved to <span id="price">x</span>\n`;

function record(testId: string, runId: string, errorMessage: string, minute = 0): TriageRecord {
  return {
    schemaVersion: 1,
    testId,
    file: `tests/${testId}.spec.ts`,
    status: 'failed',
    errorMessage,
    errorStack: errorMessage,
    duration: 100,
    retry: 0,
    attachments: [],
    runId,
    gitSha: '',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  };
}

function summary(runId: string, minute: number, testIds: string[]): RunSummary {
  const at = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  return { schemaVersion: 1, runId, gitSha: '', startedAt: at, finishedAt: at, status: 'failed', attempts: Object.fromEntries(testIds.map((t) => [t, 1])) };
}

/** Builds runs from a per-test outcome script: 'P' = pass, any other string = failure message. */
function history(script: Record<string, Array<'P' | string>>) {
  const runsCount = Math.max(...Object.values(script).map((s) => s.length));
  const records: TriageRecord[] = [];
  const summaries: RunSummary[] = [];
  for (let i = 0; i < runsCount; i++) {
    const runId = `run-${i + 1}`;
    const tests = Object.keys(script).filter((t) => script[t][i] !== undefined);
    summaries.push(summary(runId, i, tests));
    for (const t of tests) if (script[t][i] !== 'P') records.push(record(t, runId, script[t][i], i));
  }
  return { index: new HistoryIndex(records, summaries), records };
}

function diagnoseLast(script: Record<string, Array<'P' | string>>, testId: string, snapshot: SnapshotElement[] | null = null) {
  const { index, records } = history(script);
  const target = records.filter((r) => r.testId === testId).at(-1)!;
  return diagnose({ record: target, history: index.historyAsOf(testId, target.runId), run: index.runContext(target.runId), loadSnapshot: () => snapshot });
}

const SHOP_SNAPSHOT = extractPageSnapshot(
  '# Page snapshot\n\n```yaml\n- generic [ref=e1]:\n  - heading "Fixture Shop" [level=1] [ref=e2]\n  - button "Add to cart" [ref=e6]\n  - button "Proceed to checkout" [ref=e7]\n  - paragraph [ref=e5]: "Price: $24.99"\n```\n',
)!;

describe('snapshot parsing', () => {
  it('finds the snapshot of an expect() failure, which Playwright writes without a heading', () => {
    const md = '# Error details\n\n```\nError: expect(locator).toBeVisible() failed\n```\n\n```yaml\n- heading "Your order" [level=2]\n```\n\n# Test source\n';
    assert.deepEqual(extractPageSnapshot(md)?.map((e) => e.name), ['Your order']);
  });

  it('reads roles, names, inline text and refs from an ARIA snapshot', () => {
    assert.deepEqual(SHOP_SNAPSHOT.find((e) => e.ref === 'e7'), { role: 'button', name: 'Proceed to checkout', text: '', ref: 'e7' });
    assert.equal(SHOP_SNAPSHOT.find((e) => e.ref === 'e5')?.text, 'Price: $24.99');
  });
});

describe('history index', () => {
  it('computes the failing streak and what came before it, point in time', () => {
    const { index } = history({ t: ['P', 'P', 'boom', 'boom', 'P'] });
    const h = index.historyAsOf('t', 'run-4');
    assert.equal(h.runs, 4); // run-5 is in the future relative to run-4
    assert.equal(h.failingStreak, 2);
    assert.equal(h.passesBeforeStreak, 2);
    assert.equal(h.failuresBeforeStreak, 0);
  });
});

describe('ENV rules', () => {
  it('many tests failing with the same infrastructure error in one run → ENV', () => {
    const NAV = (path: string) => `TimeoutError: page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "http://app/${path}"\n`;
    const d = diagnoseLast({ a: [NAV('a')], b: [NAV('b')], c: [NAV('c')], d: ['P'] }, 'a');
    assert.equal(d.category, 'ENV');
    assert.equal(d.ruleId, 'env-mass-failure');
  });

  it('many tests unable to find their elements is a UI change, not ENV', () => {
    const d = diagnoseLast({ a: [NOT_FOUND("locator('#a')")], b: [NOT_FOUND("locator('#b')")], c: [NOT_FOUND("locator('#c')")], d: ['P'] }, 'a', []);
    assert.notEqual(d.category, 'ENV');
    assert.ok(d.evidence.some((e) => /could not find their elements/.test(e.message)));
  });

  it('many tests failing with different errors is not ENV by itself', () => {
    const d = diagnoseLast({ a: [NOT_FOUND("locator('#a')")], b: ['Error: x'], c: ['Error: y'] }, 'b', []);
    assert.equal(d.category, 'UNKNOWN');
    assert.ok(d.evidence.some((e) => e.source === 'env-mass-failure' && /different errors/.test(e.message)));
  });

  it('connection errors → ENV', () => {
    const d = diagnoseLast({ a: ['Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/'] }, 'a');
    assert.equal(d.category, 'ENV');
    assert.equal(d.confidence, 0.9);
  });

  it('expected 200 but received 5xx wins over the assertion rule, with a conflict penalty', () => {
    const msg = 'Error: GET /api/orders should return 200\n\nexpect(received).toBe(expected)\n\nExpected: 200\nReceived: 500';
    const d = diagnoseLast({ a: [msg, msg, msg] }, 'a');
    assert.equal(d.category, 'ENV');
    assert.equal(d.confidence, 0.7); // 0.8 minus the penalty, because real-bug-assertion also matched
  });

  it('a "Timeout 500ms" is not mistaken for an HTTP 500', () => {
    const d = diagnoseLast({ a: ["TimeoutError: locator.fill: Timeout 500ms exceeded.\nCall log:\n  - waiting for locator('#q')\n"] }, 'a', []);
    assert.notEqual(d.category, 'ENV');
  });
});

describe('LOCATOR_DRIFT rule', () => {
  it('missing element with a textually similar element on the page → LOCATOR_DRIFT', () => {
    const d = diagnoseLast({ a: [NOT_FOUND("locator('#checkout-button')")] }, 'a', SHOP_SNAPSHOT);
    assert.equal(d.category, 'LOCATOR_DRIFT');
    const data = d.evidence[0].data as { candidate: SnapshotElement };
    assert.equal(data.candidate.name, 'Proceed to checkout');
  });

  it('works with getByRole locators and small typos', () => {
    const d = diagnoseLast({ a: [NOT_FOUND("getByRole('button', { name: 'Add to crat' })")] }, 'a', SHOP_SNAPSHOT);
    assert.equal(d.category, 'LOCATOR_DRIFT');
  });

  it('missing element with nothing similar stays UNKNOWN and says why', () => {
    const d = diagnoseLast({ a: [NOT_FOUND("locator('#newsletter-signup')")] }, 'a', SHOP_SNAPSHOT);
    assert.equal(d.category, 'UNKNOWN');
    assert.equal(d.confidence, 0);
    assert.match(d.evidence[0].message, /nothing similar/);
  });

  it('an element that resolved (actionability problem) is not treated as missing', () => {
    const msg = "TimeoutError: locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#add')\n    - locator resolved to <button>\n    - element is not enabled\n";
    const d = diagnoseLast({ a: [msg] }, 'a', SHOP_SNAPSHOT);
    assert.notEqual(d.category, 'LOCATOR_DRIFT');
  });
});

describe('TIMING rule', () => {
  it('intermittent failures with changing errors → TIMING', () => {
    const d = diagnoseLast({ a: ['P', 'Error: got 0.1', 'P', 'Error: got 0.3', 'P', 'Error: got 0.2'] }, 'a');
    assert.equal(d.category, 'TIMING');
  });

  it('intermittent failures with one repeating error are left UNKNOWN', () => {
    const d = diagnoseLast({ a: ['P', 'Error: same', 'P', 'Error: same', 'P', 'Error: same'] }, 'a');
    assert.equal(d.category, 'UNKNOWN');
  });
});

describe('timing-retry-pass rule', () => {
  it('a failure whose retry passed in the same run → TIMING', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const r = record('a', 'run-1', "TimeoutError: locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#x')\n");
    const s: RunSummary = { schemaVersion: 1, runId: 'run-1', gitSha: '', startedAt: at, finishedAt: at, status: 'passed', attempts: { a: 2 } };
    const index = new HistoryIndex([r], [s]);
    const d = diagnose({ record: r, history: index.historyAsOf('a', 'run-1'), run: index.runContext('run-1'), loadSnapshot: () => SHOP_SNAPSHOT });
    assert.equal(d.category, 'TIMING');
    assert.equal(d.ruleId, 'timing-retry-pass');
  });

  it('a network error that passed on retry stays ENV', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const r = record('a', 'run-1', 'Error: apiRequestContext.fetch: socket hang up');
    const s: RunSummary = { schemaVersion: 1, runId: 'run-1', gitSha: '', startedAt: at, finishedAt: at, status: 'passed', attempts: { a: 2 } };
    const index = new HistoryIndex([r], [s]);
    const d = diagnose({ record: r, history: index.historyAsOf('a', 'run-1'), run: index.runContext('run-1'), loadSnapshot: () => null });
    assert.equal(d.category, 'ENV');
  });
});

describe('REAL_BUG rule', () => {
  it('value mismatch after a clean history → REAL_BUG', () => {
    const d = diagnoseLast({ a: ['P', 'P', 'P', MISMATCH('$19.99', '$24.99'), MISMATCH('$19.99', '$24.99')] }, 'a');
    assert.equal(d.category, 'REAL_BUG');
    assert.equal(d.confidence, 0.8);
  });

  it('value mismatch on the first ever run is UNKNOWN (cold start)', () => {
    const d = diagnoseLast({ a: [MISMATCH('$19.99', '$24.99')] }, 'a');
    assert.equal(d.category, 'UNKNOWN');
    assert.match(d.evidence[0].message, /first recorded run/);
  });

  it('value mismatch on a test with an on-and-off history is not REAL_BUG', () => {
    const d = diagnoseLast({ a: [MISMATCH('1', '0'), 'P', MISMATCH('1', '0')] }, 'a');
    assert.notEqual(d.category, 'REAL_BUG');
  });
});
