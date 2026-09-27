// Phase 19: a goal instead of a verb. What these tests protect is that the deciding is a policy
// and not a mood - the same state always produces the same next action, in a fixed order anyone
// can read - and that nothing which changes a file happens because Tewip felt like it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, type Observed } from '../pursue/policy.ts';
import { renderPursuit } from '../pursue/pursue-command.ts';

const nothing: Observed = { failing: [], flaky: [], uncovered: [], passing: 0, noHistory: false };
const seen = (over: Partial<Observed> = {}): Observed => ({ ...nothing, ...over });

const cannotFail = [{ name: 'rejects an expired code', file: 'tests/cart.test.js', line: 12, why: 'an expectation was written but no matcher was called on it' }];

describe('a goal that only looks green', () => {
  it('will not attest to a goal whose tests could never fail', () => {
    // The state that makes this matter: nothing failing, nothing uncovered, tests passing. Before
    // this branch existed the policy went straight to attest, which would have put a green seal on a
    // suite that cannot say no.
    const d = decide('cart', seen({ passing: 4, vacuous: cannotFail }));
    assert.equal(d.act, 'triage-vacuous-test');
    assert.match(d.why, /could never have said otherwise/);
    assert.equal(d.changesFiles, false, 'making a test check something changes what it means, so a person decides');
    assert.match(d.evidence[0], /tests\/cart\.test\.js:12/);
  });

  it('puts a test that cannot fail before a missing test', () => {
    // A missing test is honest about being missing. A test that cannot fail reads as coverage and is
    // counted as coverage, so it is the more misleading of the two.
    const d = decide('cart', seen({ passing: 4, vacuous: cannotFail, uncovered: [{ id: 'CT-9', title: 'refunds', priority: 'P0' }] }));
    assert.equal(d.act, 'triage-vacuous-test');
  });

  it('still deals with a failure first', () => {
    const d = decide('cart', seen({ passing: 2, vacuous: cannotFail, failing: [{ testId: 'cart > totals', category: 'REAL_BUG', confidence: 0.9 }] }));
    assert.equal(d.act, 'triage-real-bug', 'something red beats something hollow');
  });

  it('attests as before when the tests can fail', () => {
    assert.equal(decide('cart', seen({ passing: 4, vacuous: [] })).act, 'attest');
  });
});

describe('deciding what to do about a goal', () => {
  it('will not reason at all before it has looked', () => {
    const d = decide('keep checkout green', seen({ noHistory: true }));
    assert.equal(d.act, 'look-first');
    assert.match(d.why, /guessing from the name of a goal would be inventing/);
    assert.equal(d.changesFiles, false);
  });

  it('puts a real bug above everything else', () => {
    const d = decide('checkout', seen({
      failing: [{ testId: 'checkout > pays', category: 'REAL_BUG', confidence: 0.9 }, { testId: 'checkout > loads', category: 'ENV', confidence: 0.8 }],
      flaky: [{ testId: 'checkout > slow', times: 9 }],
      uncovered: [{ id: 'CO-1', title: 'refunds', priority: 'P0' }],
    }));
    assert.equal(d.act, 'triage-real-bug');
    assert.equal(d.changesFiles, false, 'a real bug is put in front of a person, not worked around');
  });

  it('re-runs rather than touching tests when every failure is the environment', () => {
    const d = decide('checkout', seen({ failing: [{ testId: 'a', category: 'ENV', confidence: 0.9 }, { testId: 'b', category: 'ENV', confidence: 0.8 }] }));
    assert.equal(d.act, 'rerun-environment');
    assert.match(d.why, /nothing has been shown about the code/);
  });

  it('does not call it the environment when only some of it is', () => {
    const d = decide('checkout', seen({ failing: [{ testId: 'a', category: 'ENV', confidence: 0.9 }, { testId: 'b', category: 'TIMING', confidence: 0.7 }] }));
    assert.equal(d.act, 'settle-flaky');
  });

  it('settles the flakiest test first, and says that changes files', () => {
    const d = decide('checkout', seen({ flaky: [{ testId: 'rarely', times: 2 }, { testId: 'often', times: 11 }] }));
    assert.equal(d.act, 'settle-flaky');
    assert.match(d.next, /often, which has flaked 11/);
    assert.equal(d.changesFiles, true);
  });

  it('only spends on a coverage gap once nothing is failing', () => {
    const withFailure = decide('checkout', seen({ failing: [{ testId: 'a', category: 'TIMING', confidence: 0.7 }], uncovered: [{ id: 'CO-1', title: 'refunds', priority: 'P0' }] }));
    assert.notEqual(withFailure.act, 'cover-gap');
    const quiet = decide('checkout', seen({ uncovered: [{ id: 'CO-1', title: 'refunds', priority: 'P0' }], passing: 4 }));
    assert.equal(quiet.act, 'cover-gap');
    assert.match(quiet.next, /write a test for CO-1/);
  });

  it('never moves past a failing test, whatever Tewip thinks it is', () => {
    // The policy once printed "3 failing" and then "nothing the goal depends on is failing",
    // because an undecided failure matched none of its branches and fell through to coverage.
    const d = decide('checkout', seen({
      failing: [{ testId: 'checkout > pays', category: 'UNKNOWN', confidence: 0 }],
      uncovered: [{ id: 'CO-1', title: 'refunds', priority: 'P0' }],
      passing: 3,
    }));
    assert.equal(d.act, 'triage-undecided');
    assert.match(d.why, /cannot say why/);
  });

  it('holds the invariant: nothing is failing whenever it moves on', () => {
    const categories = ['UNKNOWN', 'TEST_DATA', 'LOCATOR_DRIFT', 'REAL_BUG', 'ENV', 'TIMING'];
    for (const category of categories) {
      const d = decide('checkout', seen({ failing: [{ testId: 't', category, confidence: 0.5 }], uncovered: [{ id: 'CO-1', title: 'x', priority: 'P0' }], passing: 9 }));
      assert.ok(!['cover-gap', 'attest', 'stand-down'].includes(d.act), `${category} must not be walked past, got ${d.act}`);
    }
  });

  it('stops when the goal is met, instead of finding something to do', () => {
    const d = decide('checkout', seen({ passing: 12 }));
    assert.equal(d.act, 'attest');
    assert.match(d.why, /There is no next action worth taking/);
  });

  it('stands down when the goal names nothing it can see', () => {
    const d = decide('the invoicing rewrite', seen({}));
    assert.equal(d.act, 'stand-down');
    assert.match(d.why, /acting would mean acting on something Tewip cannot see/);
  });

  it('is a policy, not a mood: the same state decides the same way every time', () => {
    const state = seen({ failing: [{ testId: 'a', category: 'REAL_BUG', confidence: 0.9 }] });
    const runs = Array.from({ length: 5 }, () => decide('checkout', state));
    assert.equal(new Set(runs.map((r) => r.act + r.next)).size, 1);
  });

  it('never claims to have acted when it has not', () => {
    const d = decide('checkout', seen({ uncovered: [{ id: 'CO-1', title: 'refunds', priority: 'P0' }], passing: 2 }));
    const report = renderPursuit('checkout', seen({ uncovered: [{ id: 'CO-1', title: 'refunds', priority: 'P0' }], passing: 2 }), d, false);
    assert.match(report, /Tewip has not done it/);
    assert.match(report, /The order of these decisions is fixed and written down, not chosen by a model/);
  });
});
