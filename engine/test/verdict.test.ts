// Phase 24: one verdict on whether a piece of work is done.
//
// The whole value of this is that it can be relied on to say no, and to say "cannot say" instead of
// yes. So these tests are mostly about the shape of the refusals: that a broken check outranks a clean
// one, that an unanswered essential question is never rounded up to approval, that a verdict always
// lists what it says nothing about, and that the order is fixed so a person can predict it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, renderDecision, type Evidence } from '../verdict/verdict.ts';

const NL = String.fromCharCode(10);

/** A change with everything answered and nothing wrong: the only state that may be called ready. */
const sound: Evidence = {
  changedSource: ['src/refunds.js'],
  changedTests: ['tests/refunds.test.js'],
  covering: [{ testFile: 'tests/refunds.test.js', how: 'imports it' }],
  cannotFail: [],
  crashOnly: 0,
  unnoticed: [],
  failingNow: [],
  noHistory: false,
  uncovered: [],
  brokenRules: [],
};
const seen = (over: Partial<Evidence> = {}): Evidence => ({ ...sound, ...over });

const hollow = [{ name: 'a late refund is rejected', file: 'tests/refunds.test.js', line: 14, why: 'the check compares a value with itself' }];

describe('is this work done?', () => {
  it('calls sound work ready, and says how much was checked', () => {
    const decision = decide(sound);
    assert.equal(decision.verdict, 'ready');
    assert.match(decision.headline, /Ready as far as 6 check\(s\) can show/);
  });

  it('will not say ready while a test in the change cannot fail', () => {
    const decision = decide(seen({ cannotFail: hollow }));
    assert.equal(decision.verdict, 'not-ready');
    assert.match(decision.headline, /a late refund is rejected/);
  });

  it('will not say ready when the tests would not catch a bug', () => {
    const decision = decide(seen({ unnoticed: [{ file: 'src/refunds.js', line: 2, kind: 'a boundary moved by one' }] }));
    assert.equal(decision.verdict, 'not-ready');
    assert.match(decision.headline, /went unnoticed/);
  });

  it('will not say ready when nothing tests the changed code and the change adds none', () => {
    const decision = decide(seen({ covering: [], changedTests: [] }));
    assert.equal(decision.verdict, 'not-ready');
    assert.match(decision.headline, /no test imports or reaches/);
  });

  // Phase 46, found by running this verdict over six real merged Saleor pull requests: four came
  // back "Not ready" and all four shipped a test for exactly the change they were making. Coverage
  // here is followed through imports, and a test that posts a GraphQL query and asserts the error
  // never imports the resolver chain in between. A gate that says "not ready" to a correct pull
  // request is uninstalled within a week.
  it('says cannot say, not no, when the change ships tests the imports cannot see', () => {
    const decision = decide(seen({ covering: [] }));
    assert.equal(decision.verdict, 'cannot-say');
    assert.match(decision.headline, /"Is the changed code tested\?"/);
    assert.match(decision.headline, /one question that matters/);
    const check = decision.checks.find((c) => c.question === 'Is the changed code tested?');
    assert.equal(check?.standing, 'not-checked');
    assert.match(check?.answer ?? '', /framework entry point/);
  });

  it('puts what is failing above everything else', () => {
    // Everything is wrong at once: the answer has to be the red test, because nothing else matters
    // while something the change touches is broken.
    const decision = decide(seen({ failingNow: [{ testId: 'refunds > totals', category: 'REAL_BUG' }], cannotFail: hollow, covering: [], unnoticed: [{ file: 'src/refunds.js', line: 2, kind: 'x' }] }));
    assert.equal(decision.verdict, 'not-ready');
    assert.match(decision.headline, /failed in the last run/);
  });

  it('says "cannot say" rather than ready when it has never seen a test result', () => {
    // The first version answered "Ready, with 3 not checked" on a project with no history at all -
    // an approval assembled out of shrugs. An unanswered essential question is not a pass.
    const decision = decide(seen({ noHistory: true }));
    assert.equal(decision.verdict, 'cannot-say');
    assert.match(decision.headline, /"Is anything failing\?" - so this is not an approval/);
    assert.match(decision.headline, /not an approval/);
  });

  it('is not troubled by the expensive check being skipped, but says so', () => {
    const decision = decide(seen({ unnoticed: null }));
    assert.equal(decision.verdict, 'ready', 'proving is optional; its absence is reported, not punished');
    assert.ok(decision.notChecked.some((n) => n.includes('would the tests catch a bug')));
    assert.match(renderDecision('main...HEAD', decision), /not checked/);
  });

  it('always says what it says nothing about', () => {
    for (const evidence of [sound, seen({ noHistory: true }), seen({ cannotFail: hollow })]) {
      const decision = decide(evidence);
      assert.ok(decision.notChecked.length >= 2, 'a verdict with no stated limits is a verdict nobody should trust');
      assert.ok(decision.notChecked.some((n) => /does what was intended/.test(n)), 'it can never know whether the change is the right change');
    }
  });

  it('marks a change with no tests in it as not applicable rather than failing it', () => {
    const decision = decide(seen({ changedTests: [] }));
    assert.equal(decision.verdict, 'ready');
    assert.equal(decision.checks.find((c) => c.question.startsWith('Can the tests'))?.standing, 'not-applicable');
  });

  it('keeps the questions in a fixed order, so the answer can be predicted', () => {
    assert.deepEqual(
      decide(sound).checks.map((c) => c.question),
      [
        'Is anything failing?',
        'Is the changed code tested?',
        'Can the tests in this change fail?',
        'Would the tests catch a bug in this code?',
        "Does it keep this project's own standards?",
        'Is what was asked for covered?',
      ],
    );
  });

  it('will not say ready while the change breaks a rule this team wrote', () => {
    const decision = decide(seen({ brokenRules: [{ standard: 'no-fixed-waits', file: 'tests/checkout.spec.ts', line: 5, why: 'a fixed wait passes by luck' }] }));
    assert.equal(decision.verdict, 'not-ready');
    assert.match(decision.headline, /no-fixed-waits/);
  });

  it('says a project that has written no standards has none to keep', () => {
    const decision = decide(seen({ brokenRules: null }));
    assert.equal(decision.verdict, 'ready', 'having no house rules is not a failure');
    assert.ok(decision.notChecked.some((n) => n.includes('own standards')));
  });

  it('names which layer decided each answer, so a claim can be traced to a measurement', () => {
    for (const check of decide(sound).checks) {
      assert.ok(check.decidedBy.length > 3, `${check.question} does not say what decided it`);
    }
  });

  it('reads as a verdict rather than a table dump', () => {
    const report = renderDecision('main...HEAD', decide(seen({ cannotFail: hollow })));
    assert.match(report, /^# Is this work done\? Not ready/);
    assert.match(report, /## What this says nothing about/);
    assert.doesNotMatch(report, new RegExp(`\\.\\.${NL}`), 'no doubled full stops');
  });
});
