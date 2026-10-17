// The flake dossier. The interesting tests here are the refusals: a test that mostly fails is
// broken rather than flaky and must not be hidden, and a test whose failures were the application
// being wrong must never be quarantined - that would hide the bug it exists to catch.
import assert from 'node:assert/strict';
import { decide, type FlakyTest } from '../flaky/flaky.ts';
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

// Phase 57: `flaky` measured against 1,305 real failures from WordPress/gutenberg.
//
// It recommended quarantining nothing. Every quarantine verdict rested on `flakyShare` - how many
// failures a *previous* `tewip explain` had already called flaky - so on raw history, where nothing
// has been diagnosed, no test could ever qualify. 124 of the 180 failing tests had failed and then
// passed on a retry in the same run, and all 124 were filed under "watch". One had done it 93 times.
describe('flakiness that was observed rather than diagnosed', () => {
  const test = (over: Partial<FlakyTest> = {}): FlakyTest =>
    ({
      testId: 'a > b',
      title: 'b',
      file: 'spec/a.spec.js',
      failedRuns: 93,
      totalRuns: 650,
      failedAttempts: 93,
      wastedMs: 1_200_000,
      recoveredOnRetry: 0,
      branches: ['trunk'],
      categories: [{ category: 'UNKNOWN', count: 93 }],
      firstSeen: '2026-10-01T00:00:00Z',
      lastSeen: '2026-10-17T00:00:00Z',
      verdict: 'watch',
      why: '',
      ...over,
    }) as FlakyTest;

  it('quarantines a test that failed and then passed on the same code', () => {
    // No diagnosis needed: same run, same commit, same machine, both outcomes.
    const { verdict, why } = decide(test({ recoveredOnRetry: 93, branches: Array.from({ length: 61 }, (_, i) => `b${i}`) }), { minRuns: 3, alwaysFailsAbove: 0.8 });
    assert.equal(verdict, 'quarantine');
    assert.match(why, /failed and then passed on a retry in the same run 93 times/);
    assert.match(why, /61 different branches/);
  });

  it('still refuses to hide a test that is simply broken', () => {
    // Failing nearly every run is not flakiness, and recovering once does not make it so.
    const { verdict, why } = decide(test({ failedRuns: 95, totalRuns: 100, recoveredOnRetry: 1 }), { minRuns: 3, alwaysFailsAbove: 0.8 });
    assert.equal(verdict, 'fix-now');
    assert.match(why, /not flakiness/);
  });

  it('still refuses to hide a test whose failures looked like real bugs', () => {
    const { verdict, why } = decide(test({ recoveredOnRetry: 5, categories: [{ category: 'REAL_BUG', count: 80 }] }), { minRuns: 3, alwaysFailsAbove: 0.8 });
    assert.equal(verdict, 'fix-now');
    assert.match(why, /Quarantining it would hide a bug/);
  });

  it('does not quarantine on a single blip', () => {
    assert.equal(decide(test({ recoveredOnRetry: 1, failedRuns: 1, totalRuns: 400 }), { minRuns: 3, alwaysFailsAbove: 0.8 }).verdict, 'watch');
  });
});

// Phase 58: the boundaries `tewip prove` found nothing checking.
//
// Run against flaky.ts - a file whose tests had been written hours earlier, in Phase 57 - prove
// broke it in six deliberate ways and **five went unnoticed**. Every one was a boundary or a
// connective that the tests happened to step over rather than land on: `>=` became `>`, `||` became
// `&&`, and every test still passed. The line was covered. It was not checked.
describe('the edges of the flaky verdict', () => {
  const opts = { minRuns: 2, alwaysFailsAbove: 0.8 };
  const base = (over: Partial<FlakyTest> = {}): FlakyTest =>
    ({
      testId: 'a > b', title: 'b', file: 'spec/a.spec.js',
      failedRuns: 5, totalRuns: 100, failedAttempts: 10, wastedMs: 1000,
      recoveredOnRetry: 0, branches: ['trunk'],
      categories: [{ category: 'UNKNOWN', count: 10 }],
      firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-17T00:00:00Z',
      verdict: 'watch', why: '', ...over,
    }) as FlakyTest;

  it('calls it a bug at exactly half the failures, not just above half', () => {
    // `realBugs >= failedAttempts / 2` survived becoming `>`, because no test sat on the boundary.
    // Exactly half looking like the application being wrong is still too many to hide.
    assert.equal(decide(base({ failedAttempts: 10, categories: [{ category: 'REAL_BUG', count: 5 }] }), opts).verdict, 'fix-now');
    assert.equal(decide(base({ failedAttempts: 10, categories: [{ category: 'REAL_BUG', count: 4 }] }), opts).verdict, 'watch');
  });

  it('quarantines at exactly the minimum number of runs, not one above it', () => {
    // `failedRuns >= minRuns` survived becoming `>`: the Phase 57 test used failedRuns: 1, which is
    // nowhere near the edge it was meant to be defending.
    assert.equal(decide(base({ recoveredOnRetry: 1, failedRuns: 2 }), opts).verdict, 'quarantine');
    assert.equal(decide(base({ recoveredOnRetry: 1, failedRuns: 1 }), opts).verdict, 'watch');
  });

  it('only blames the branches when there is more than one of them', () => {
    // `branches.length > 1` survived becoming `>= 1`, which would have told every team that a test
    // failing on their single trunk "failed on 1 different branches, so it is the test".
    const many = decide(base({ recoveredOnRetry: 1, branches: ['trunk', 'release'] }), opts);
    assert.match(many.why, /2 different branches/);
    const one = decide(base({ recoveredOnRetry: 1, branches: ['trunk'] }), opts);
    assert.doesNotMatch(one.why, /different branches/);
  });

  it('breaks a tie on wasted time by how many runs it broke', () => {
    // The sort's `||` survived becoming `&&`, which collapses the comparison to a boolean and loses
    // the tiebreak - the report would still look sorted while not being. The first attempt at this
    // test sorted a local array instead of calling flakyTests, so prove reported the mutant alive
    // again and was right to: a test that re-implements the line it is checking checks nothing.
    const runsHere = Array.from({ length: 6 }, (_, i) => run(`t${i}`, day(i + 1), 'main', ['x > slow', 'x > often']));
    const records = [
      // Equal wasted time: one failure of 60s against three of 20s.
      record('x > slow', 't0', 'UNKNOWN', day(1), 60_000),
      record('x > often', 't1', 'UNKNOWN', day(2), 20_000),
      record('x > often', 't2', 'UNKNOWN', day(3), 20_000),
      record('x > often', 't3', 'UNKNOWN', day(4), 20_000),
    ];
    const ranked = flakyTests(records, runsHere, {});
    assert.equal(ranked[0].wastedMs, ranked[1].wastedMs, 'the two really are tied on wasted time');
    assert.equal(ranked[0].testId, 'x > often', 'the one that broke more runs is ranked first');
  });

  it('counts the attempts of this run, not of some other run', () => {
    // `run.runId === runId` survived becoming `!==`, which would take the attempt count from a
    // different run entirely - every number in the report downstream of it would be another run's.
    const runsHere = [
      { ...run('r1', day(1), 'main', ['x > a']), attempts: { 'x > a': 3 } } as RunSummary,
      { ...run('r2', day(2), 'main', ['x > a']), attempts: { 'x > a': 1 } } as RunSummary,
    ];
    const [only] = flakyTests([record('x > a', 'r1', 'UNKNOWN', day(1), 10_000)], runsHere, {});
    // r1 ran it three times and recorded one failure, so two later attempts passed. Reading r2's
    // single attempt instead would say nothing recovered, and the retry story would be lost.
    assert.equal(only.recoveredOnRetry, 1, 'the retry that passed belongs to r1, not to r2');
    assert.equal(only.failedRuns, 1, 'it failed in r1 only');
  });
});

// Phase 58, the second pass: `--limit 6` had sampled 6 of the 14 changes this file allows and
// reported them all caught. Asking about all 14 found five more holes, every one of them on a line
// the sample never visited. The lesson is the report's, not the suite's: a partial answer that does
// not say it is partial reads exactly like a whole one.
describe('the arithmetic underneath the verdict', () => {
  const opts = { minRuns: 2, alwaysFailsAbove: 0.8 };
  const base = (over: Partial<FlakyTest> = {}): FlakyTest =>
    ({
      testId: 'a > b', title: 'b', file: 'spec/a.spec.js',
      failedRuns: 5, totalRuns: 100, failedAttempts: 10, wastedMs: 1000,
      recoveredOnRetry: 0, branches: ['trunk'],
      categories: [{ category: 'UNKNOWN', count: 10 }],
      firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-17T00:00:00Z',
      verdict: 'watch', why: '', ...over,
    }) as FlakyTest;

  it('does not divide by a run count of zero', () => {
    // `totalRuns > 0` survived becoming `>= 0`, which divides by zero and prints "Infinity% of the
    // 0 run(s) it was in" - a number no reader can do anything with, in the sentence that is
    // supposed to justify the verdict.
    const why = decide(base({ totalRuns: 0, failedRuns: 1 }), opts).why;
    assert.match(why, /100% of the 0 run\(s\)/, 'no runs recorded is treated as "it always failed", not as Infinity');
  });

  it('does not divide by an attempt count of zero', () => {
    // `failedAttempts > 0` survived becoming `>= 0`: with a diagnosed category and no attempts
    // recorded, the flaky share came out Infinity and sailed past the 0.5 gate, so a test nobody
    // has any attempt data for would be recommended for quarantine.
    const odd = base({ failedRuns: 2, failedAttempts: 0, categories: [{ category: 'TIMING', count: 3 }] });
    assert.equal(decide(odd, opts).verdict, 'watch', 'no attempts recorded is no evidence, not overwhelming evidence');
  });

  it('calls a test broken at exactly the minimum run count, not one above it', () => {
    // `totalRuns >= minRuns` survived becoming `>`: a test that failed both of the two runs it was
    // in is the clearest "this test does not work" there is, and it was being filed under watch.
    assert.equal(decide(base({ failedRuns: 2, totalRuns: 2 }), opts).verdict, 'fix-now');
    assert.equal(decide(base({ failedRuns: 1, totalRuns: 1 }), opts).verdict, 'watch', 'one run is not a pattern');
  });

  it('quarantines a diagnosed test at exactly the minimum run count', () => {
    // `failedRuns >= minRuns` survived becoming `>` on the diagnosed path too - the same off-by-one
    // as the observed path above, in the branch that reads `tewip explain`'s own categories.
    const timing = (failedRuns: number) => base({ failedRuns, categories: [{ category: 'TIMING', count: 5 }] });
    assert.equal(decide(timing(2), opts).verdict, 'quarantine');
    assert.equal(decide(timing(1), opts).verdict, 'watch');
  });

  it('does not blame one branch for being several, on the diagnosed path either', () => {
    // `branches.length > 1` survived becoming `>= 1` here, which is the same sentence this file
    // already pins on the observed path. Both say "failed on 1 different branches, so it is the
    // test rather than one person's change" - a conclusion drawn from nothing.
    const one = decide(base({ failedRuns: 3, branches: ['trunk'], categories: [{ category: 'TIMING', count: 6 }] }), opts);
    assert.equal(one.verdict, 'quarantine');
    assert.doesNotMatch(one.why, /different branches/, 'one branch is not a spread');
    const two = decide(base({ failedRuns: 3, branches: ['trunk', 'release'], categories: [{ category: 'TIMING', count: 6 }] }), opts);
    assert.match(two.why, /2 different branches/);
  });
});
