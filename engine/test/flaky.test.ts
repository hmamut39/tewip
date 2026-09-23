// The flake dossier. The interesting tests here are the refusals: a test that mostly fails is
// broken rather than flaky and must not be hidden, and a test whose failures were the application
// being wrong must never be quarantined - that would hide the bug it exists to catch.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { flakyTests, readyToRelease, weeklyCost } from '../flaky/flaky.ts';
import { applyQuarantine, frameworkOf, quarantineFor } from '../flaky/quarantine.ts';

const NL = String.fromCharCode(10);
const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();

const record = (testId: string, runId: string, category: string, at: string, duration = 30_000): TriageRecord =>
  ({ schemaVersion: 1, testId, file: 'tests/cart.spec.ts', status: 'failed', errorMessage: '', errorStack: '', duration, retry: 0, attachments: [], runId, gitSha: '', timestamp: at, diagnosis: { category } }) as unknown as TriageRecord;

const run = (runId: string, at: string, branch: string, tests: string[]): RunSummary =>
  ({ schemaVersion: 1, runId, gitSha: '', branch, startedAt: at, finishedAt: at, status: 'failed', attempts: Object.fromEntries(tests.map((t) => [t, 1])) }) as RunSummary;

const ALL = ['cart > a', 'cart > b', 'cart > c'];
const runs = Array.from({ length: 10 }, (_, i) => run(`r${i}`, day(i + 1), i % 2 === 0 ? 'main' : `pr-${i}`, ALL));

describe('what the history says about a test', () => {
  it('quarantines one that is unreliable across several runs and branches', () => {
    const records = [0, 2, 4, 6].map((i) => record('cart > a', `r${i}`, 'TIMING', day(i + 1)));
    const [test] = flakyTests(records, runs);
    assert.equal(test.verdict, 'quarantine');
    assert.equal(test.failedRuns, 4);
    assert.equal(test.totalRuns, 10);
    assert.match(test.why, /40% of the 10 run\(s\)/);
    assert.match(test.why, /the test being unreliable/);
  });

  it('refuses to hide a test that nearly always fails', () => {
    const records = runs.slice(0, 9).map((r, i) => record('cart > b', r.runId, 'TIMING', day(i + 1)));
    const test = flakyTests(records, runs).find((t) => t.testId === 'cart > b')!;
    assert.equal(test.verdict, 'fix-now');
    assert.match(test.why, /not flakiness, it is a test that does not work/);
  });

  it('never quarantines a test whose failures were the application being wrong', () => {
    const records = [
      record('cart > c', 'r0', 'REAL_BUG', day(1)),
      record('cart > c', 'r2', 'REAL_BUG', day(3)),
      record('cart > c', 'r4', 'TIMING', day(5)),
    ];
    const test = flakyTests(records, runs).find((t) => t.testId === 'cart > c')!;
    assert.equal(test.verdict, 'fix-now');
    assert.match(test.why, /Quarantining it would hide a bug/);
  });

  it('waits for evidence instead of acting on one failure', () => {
    const [test] = flakyTests([record('cart > a', 'r0', 'TIMING', day(1))], runs);
    assert.equal(test.verdict, 'watch');
  });

  it('counts what it costs per week, not just in total', () => {
    const records = [0, 2, 4, 6].map((i) => record('cart > a', `r${i}`, 'TIMING', day(i + 1), 60_000));
    const cost = weeklyCost(flakyTests(records, runs), 14);
    assert.equal(cost.minutes, 2, 'four minutes over two weeks is two a week');
    assert.equal(cost.attempts, 2);
  });

  it('says which tests have earned their way out of quarantine', () => {
    // 'a' failed inside the window; 'b' ran throughout and never did.
    const records = [record('cart > a', 'r4', 'TIMING', day(5))];
    const back = readyToRelease(['cart > a', 'cart > b'], records, runs, day(2));
    assert.deepEqual(back, ['cart > b'], 'the one that ran and never failed comes back');
  });
});

describe('the line that quarantines a test', () => {
  const test = { testId: 'cart > a', title: 'adds an item', file: 'tests/cart.spec.ts', failedRuns: 4, totalRuns: 10, failedAttempts: 5, wastedMs: 120_000, recoveredOnRetry: 2, branches: ['main', 'pr-1'], categories: [{ category: 'TIMING', count: 5 }], firstSeen: day(1), lastSeen: day(7), verdict: 'quarantine' as const, why: '' };

  it('knows each framework by the file and what it imports', () => {
    assert.equal(frameworkOf('tests/cart.spec.ts', "import { test } from '@playwright/test';"), 'playwright');
    assert.equal(frameworkOf('tests/cart.test.ts', "import { describe, it, vi } from 'vitest';"), 'vitest');
    assert.equal(frameworkOf('tests/test_cart.py', 'def test_x():'), 'pytest');
    assert.equal(frameworkOf('src/CartTest.java', 'class CartTest {}'), 'junit');
  });

  it('writes the evidence above the line, in the project\'s own words', () => {
    const { line, comment } = quarantineFor(test, 'playwright');
    assert.match(line, /test\.fixme\(true, "quarantined by Tewip: adds an item"\)/);
    assert.match(comment[0], /failed in 4 of 10 runs, 2 CI minute\(s\) lost/);
    assert.match(comment.join(' '), /2 branches, so it is the test and not one change/);
    assert.match(comment.join(' '), /Take this line out/);
  });

  it('changes only the test named, and leaves everything else byte for byte', () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('adds an item', async ({ page }) => {",
      "  await page.goto('/cart');",
      '});',
      '',
      "test('removes an item', async ({ page }) => {",
      "  await page.goto('/cart');",
      '});',
      '',
    ].join(NL);
    const changed = applyQuarantine(source, test, 'playwright')!;
    assert.match(changed, /Quarantined by Tewip on \d{4}-\d{2}-\d{2}/);
    assert.match(changed, /test\.fixme\(true, "quarantined by Tewip: adds an item"\);/);
    assert.ok(changed.includes("test('removes an item', async ({ page }) => {"), 'the other test is untouched');
    assert.equal(changed.split('removes an item').length, 2, 'nothing was duplicated');
  });

  it('does not quarantine the same test twice', () => {
    const source = ["test('adds an item', async ({ page }) => {", '});'].join(NL);
    const once = applyQuarantine(source, test, 'playwright')!;
    assert.equal(applyQuarantine(once, test, 'playwright'), once, 'running it again changes nothing');
  });

  it('says it could not find the test rather than guessing', () => {
    assert.equal(applyQuarantine("test('something else', () => {});", test, 'playwright'), null);
  });

  it('skips the call for jest and vitest, where that is how it is done', () => {
    const source = ["it('adds an item', () => {", '  expect(1).toBe(1);', '});'].join(NL);
    const changed = applyQuarantine(source, test, 'vitest')!;
    assert.match(changed, /test\.skip\('adds an item'/);
  });
});
