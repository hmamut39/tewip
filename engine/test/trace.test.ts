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
