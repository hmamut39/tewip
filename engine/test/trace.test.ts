// Phase 18: the thread from what was asked for to what is passing. What these tests protect is
// the refusal to guess: "covered" needs a test that can be named, "passing" needs a run that
// attempted it, and everything else has to say what is missing instead. A green thread nobody
// checked is worse than no thread.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderTrace, testFor, tracePlan, type PlanFile } from '../trace/trace.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';

const run = (runId: string, attempts: string[], finishedAt = '2026-09-26T10:00:00.000Z'): RunSummary =>
  ({ schemaVersion: 1, runId, gitSha: '', startedAt: finishedAt, finishedAt, status: 'passed', attempts: Object.fromEntries(attempts.map((a) => [a, 1])) }) as RunSummary;

const failed = (runId: string, testId: string, category = 'REAL_BUG'): TriageRecord =>
  ({ schemaVersion: 1, testId, file: 'f', status: 'failed', errorMessage: 'boom', errorStack: '', duration: 1, retry: 0, attachments: [], runId, gitSha: '', timestamp: '2026-09-26T10:00:00.000Z', diagnosis: { category, confidence: 0.7, source: 'rules', evidence: [] } }) as unknown as TriageRecord;

const plan = (scenarios: PlanFile['scenarios']): PlanFile => ({ title: 'Checkout', ticket: 'SHOP-12', scenarios });

describe('the thread from a requirement to a run', () => {
  it('calls a scenario passing only when a real run attempted its test', () => {
    const traced = tracePlan(plan([{ id: 'CT-001', title: 'totals the order', covered_by: 'tests/cart.test.js > totals the order' }]), [run('r1', ['tests/cart.test.js > totals the order'])], []);
    assert.equal(traced.scenarios[0].standing, 'passing');
    assert.equal(traced.scenarios[0].runId, 'r1');
    assert.match(traced.scenarios[0].why, /attempted in the last run and recorded no failure/);
  });

  it('calls it failing and quotes what Tewip decided', () => {
    const test = 'tests/cart.test.js > totals the order';
    const traced = tracePlan(plan([{ id: 'CT-001', title: 'totals the order', covered_by: test }]), [run('r1', [test])], [failed('r1', test)]);
    assert.equal(traced.scenarios[0].standing, 'failing');
    assert.match(traced.scenarios[0].diagnosis, /REAL_BUG at 0\.70 \(rules\)/);
  });

  it('says a named test has never run here, rather than assuming it passed', () => {
    const traced = tracePlan(plan([{ id: 'CT-002', title: 'applies a discount', covered_by: 'tests/discount.test.js > applies a discount' }]), [run('r1', ['something else'])], []);
    assert.equal(traced.scenarios[0].standing, 'never-run');
    assert.match(traced.scenarios[0].why, /no run kept here has attempted it/);
  });

  it('says a scenario is not covered rather than finding the nearest test', () => {
    const traced = tracePlan(plan([{ id: 'CT-003', title: 'zero quantity' }]), [run('r1', ['tests/cart.test.js > something unrelated'])], []);
    assert.equal(traced.scenarios[0].standing, 'not-covered');
    assert.equal(traced.scenarios[0].test, '');
  });

  it('finds the test `tewip write` created, which carries the scenario id', () => {
    const attempted = ['tests/tewip-ct-001.test.js > cart > adds up multiple item lines'];
    assert.equal(testFor({ id: 'CT-001', title: 'x' }, attempted), attempted[0]);
    assert.equal(testFor({ id: 'CT-999', title: 'x' }, attempted), '', 'a different id matches nothing');
  });

  it('never quotes a run beside a scenario nothing checks', () => {
    // Printing the last run under "no test can be named for it" invited the reader to believe one
    // had checked it.
    const report = renderTrace([tracePlan(plan([{ id: 'CT-003', title: 'zero quantity' }]), [run('r1', ['unrelated'])], [])]);
    assert.match(report, /NOT COVERED/);
    assert.doesNotMatch(report, /From run/);
  });

  it('counts the standings and says what to do first', () => {
    const test = 'tests/cart.test.js > totals';
    const report = renderTrace([
      tracePlan(plan([
        { id: 'CT-001', title: 'totals', covered_by: test },
        { id: 'CT-002', title: 'discount' },
      ]), [run('r1', [test])], [failed('r1', test)]),
    ]);
    assert.match(report, /1 failing/);
    assert.match(report, /1 not covered/);
    assert.match(report, /## What to do first/);
    assert.match(report, /write a test for CT-002/);
  });

  it('says plainly when there is no plan to trace', () => {
    assert.match(renderTrace([]), /No plan has been kept here/);
  });
});

// Phase 66: field-tested by writing a real plan with `tewip plan` for a real feature of this
// repository and tracing it. All twelve scenarios came back **"no test in this project can be named
// for it, so nothing is checking it"** - in a repository with 1,095 passing tests. Two reasons, and
// each was its own defect.
describe('what trace can see, and what it says when it cannot see', () => {
  const idTest = 'tests/tewip-ct-001.test.js > cart > adds up multiple item lines';

  it('finds a test by scenario id in an older run, not only in the newest one', () => {
    // The id was matched against the newest run alone, so a test that ran last week and not today
    // could not be found at all - and was reported as nothing checking it, which is a far stronger
    // claim than "it did not run today". The branch written to say that was unreachable.
    const traced = tracePlan(plan([{ id: 'CT-001', title: 'adds up lines' }]), [run('r1', [idTest], '2026-09-20T10:00:00.000Z'), run('r2', ['something else'])], []);
    assert.equal(traced.scenarios[0].test, idTest, 'the test exists in the kept history');
    assert.equal(traced.scenarios[0].standing, 'never-run');
    assert.match(traced.scenarios[0].why, /ran before but not in the last run/);
  });

  it('still calls it passing when that test is in the newest run', () => {
    const traced = tracePlan(plan([{ id: 'CT-001', title: 'adds up lines' }]), [run('r1', ['older']), run('r2', [idTest])], []);
    assert.equal(traced.scenarios[0].standing, 'passing');
  });

  it('does not claim nothing checks a scenario when no run has been kept at all', () => {
    // This is the field-test case: a real plan, a real suite, and no kept run - so Tewip has no list
    // of the project's tests and was saying "nothing is checking it" as though it had looked.
    const traced = tracePlan(plan([{ id: 'CT-003', title: 'zero quantity' }]), [], []);
    assert.equal(traced.scenarios[0].standing, 'not-covered');
    assert.match(traced.scenarios[0].why, /no run has been kept for this project/);
    assert.match(traced.scenarios[0].why, /this is not a claim that nothing checks it/);
    assert.match(traced.scenarios[0].why, /tewip explain/, 'and what to do about it');
  });

  it('says how many tests it did search when it has some', () => {
    const traced = tracePlan(plan([{ id: 'CT-003', title: 'zero quantity' }]), [run('r1', ['a', 'b']), run('r2', ['b', 'c'])], []);
    assert.match(traced.scenarios[0].why, /no test among the 3 that the 2 kept run\(s\) name matches it/);
    assert.match(traced.scenarios[0].why, /nothing Tewip can see is checking it/, 'what it can see, not what exists');
  });
});
