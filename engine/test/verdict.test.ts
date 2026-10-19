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
    couldNotJudge: 0,
    proofsTried: 1,
    proofSkipped: '',
    plansUnreadable: 0,
    plansConsidered: 1,
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
    assert.match(decision.headline, /"Is everything passing\?" - so this is not an approval/);
    assert.match(decision.headline, /not an approval/);
  });

  it('does not call a change covered when the plan could not be read', () => {
    // `.tewip/plans/refunds.json` containing one line of nothing. The parse failed, the file was
    // skipped in silence, and the gap list came back empty - which is also what it does when every
    // scenario is covered. The gate said "every scenario this change relates to has a test".
    const unreadable = seen({ uncovered: [], plansUnreadable: 1, plansConsidered: 0 });
    const check = decide(unreadable).checks.find((c) => c.question === 'Is what was asked for covered?');
    assert.equal(check?.standing, 'not-checked');
    assert.match(check?.answer ?? '', /1 plan file\(s\) here could not be read/);
  });

  it('does not call a change covered when no plan is about it', () => {
    const unrelated = seen({ uncovered: [], plansUnreadable: 0, plansConsidered: 0 });
    const check = decide(unrelated).checks.find((c) => c.question === 'Is what was asked for covered?');
    assert.equal(check?.standing, 'not-checked');
    assert.match(check?.answer ?? '', /nothing to compare it with/);
  });

  it('still says yes when a plan was read and every scenario is covered', () => {
    const check = decide(seen({ uncovered: [], plansUnreadable: 0, plansConsidered: 1 })).checks.find((c) => c.question === 'Is what was asked for covered?');
    assert.equal(check?.standing, 'met');
  });

  it('still says no when a scenario has no test', () => {
    const gap = seen({ uncovered: [{ id: 'LS-2', title: 'refuses an unpaid order' }], plansConsidered: 1 });
    const check = decide(gap).checks.find((c) => c.question === 'Is what was asked for covered?');
    assert.equal(check?.standing, 'not-met');
  });

  it('does not call the tests proved when nothing could be proved', () => {
    // Asked for --prove on a project whose runner is not installed, `proveChanged` returns no proofs
    // and a reason. `unnoticed` is then empty in exactly the way it is when every change was caught,
    // and the gate answered "every deliberate change made to this code was noticed" - about no
    // changes at all, in its strongest claim, to somebody who had asked for it specifically.
    const nothingRan = seen({ unnoticed: [], proofsTried: 0, proofSkipped: 'no unit test framework was found here, and proving works by running tests' });
    const check = decide(nothingRan).checks.find((c) => c.question === 'Would the tests catch a bug in this code?');
    assert.ok(check);
    assert.equal(check.standing, 'not-checked');
    assert.match(check.answer, /no unit test framework was found here/, 'and says why, not just that it did not');
  });

  it('still says yes when changes really were made and caught', () => {
    const check = decide(seen({ unnoticed: [], proofsTried: 4 })).checks.find((c) => c.question === 'Would the tests catch a bug in this code?');
    assert.equal(check?.standing, 'met');
  });

  it('still says no when a change slipped past', () => {
    const slipped = seen({ unnoticed: [{ file: 'src/refunds.js', line: 2, kind: 'a comparison inverted' }], proofsTried: 4 });
    const check = decide(slipped).checks.find((c) => c.question === 'Would the tests catch a bug in this code?');
    assert.equal(check?.standing, 'not-met');
  });

  it('still says not checked when proving was never asked for', () => {
    const check = decide(seen({ unnoticed: null })).checks.find((c) => c.question === 'Would the tests catch a bug in this code?');
    assert.equal(check?.standing, 'not-checked');
    assert.match(check?.answer ?? '', /Ask for it with/);
  });

  it('does not call tests sound when it could not judge any of them', () => {
    // The shape a machine writes: call the function under test, assert nothing. vouch declines each
    // one - the body is a single call to something it cannot follow - so `cannotFail` comes back
    // empty, exactly as it does for three good tests. The gate read the empty list and answered
    // "every test in this change asserts something" about three tests that assert nothing.
    const blind = seen({ changedTests: ['test/refunds.test.js'], cannotFail: [], couldNotJudge: 3 });
    const check = decide(blind).checks.find((c) => c.question === 'Can the tests in this change fail?');
    assert.ok(check);
    assert.equal(check.standing, 'not-checked');
    assert.match(check.answer, /would not judge any of the 3 test\(s\)/);
  });

  it('still says yes when it judged them and they assert', () => {
    const check = decide(seen({ changedTests: ['test/refunds.test.js'], couldNotJudge: 0 })).checks.find((c) => c.question === 'Can the tests in this change fail?');
    assert.equal(check?.standing, 'met');
  });

  it('still says no when one of them cannot fail', () => {
    // A finding outranks an absence: some were judged and one is bad.
    const mixed = seen({
      changedTests: ['test/refunds.test.js'],
      cannotFail: [{ name: 'works', file: 'test/refunds.test.js', line: 3, why: 'compares a value with itself' }],
      couldNotJudge: 2,
    });
    const check = decide(mixed).checks.find((c) => c.question === 'Can the tests in this change fail?');
    assert.equal(check?.standing, 'not-met');
  });

  it('never says a word that reads like reassurance while a test is failing', () => {
    // The table renders each check's standing as yes or no, so the questions have to be phrased so
    // that a yes is good news. "Is anything failing?" was not: with a test genuinely failing, the
    // standing was not-met and the row read "Is anything failing? **no**" - true of the standing,
    // backwards as an answer, and the table is what a reviewer scans first. The headline said Not
    // ready and named the test; the row beside it still read like reassurance.
    const failing = seen({ failingNow: [{ testId: 'refunds > partial refund', category: 'REAL_BUG' }] });
    const row = renderDecision('main...HEAD', decide(failing))
      .split(String.fromCharCode(10))
      .find((l) => l.includes('|') && /passing|failing/.test(l));
    assert.ok(row, 'the run-state question has a row');
    assert.match(row, /\*\*no\*\*/, 'a failing test must read as a no');
    assert.doesNotMatch(row, /\|\s*yes\s*\|/, 'and must never read as a yes');
  });

  it('reads as a yes when nothing is failing', () => {
    const row = renderDecision('main...HEAD', decide(seen()))
      .split(String.fromCharCode(10))
      .find((l) => l.includes('|') && /passing|failing/.test(l));
    assert.match(row ?? '', /\|\s*yes\s*\|/);
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
        'Is everything passing?',
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

// Phase 58: found by running `tewip prove engine/verdict/verdict.ts --limit 20` on Tewip itself.
// Three changes to this file went unnoticed by the suite above, and all three were on lines that
// only a full run reached - a sampled run reported them as caught and said so with no caveat.
describe('the lines a sampled proof run never reached', () => {
  const covered = (executed: string[]): Partial<Evidence> => ({
    covering: [],
    coverage: { from: 'coverage/lcov.info', executed, notExecuted: [] },
  });

  it('does not call a change tested when coverage records nothing executed', () => {
    // `executed.length > 0` survived becoming `>= 0`, which answers "yes, the suite executes "
    // with an empty list - a met check, sourced from real coverage, resting on nothing.
    const asked = decide(seen(covered([]))).checks.find((c) => c.question === 'Is the changed code tested?');
    assert.notEqual(asked?.standing, 'met', 'an empty executed list is not evidence that anything ran');
  });

  it('counts the files it did not list rather than inventing more of them', () => {
    // `executed.length - 3` survived becoming `+ 3`: with five covered files the answer read
    // "and 8 more", a number larger than the whole list it came from.
    const five = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
    const asked = decide(seen(covered(five))).checks.find((c) => c.question === 'Is the changed code tested?');
    assert.equal(asked?.standing, 'met');
    assert.match(asked?.answer ?? '', /and 2 more/, 'three were named, so two are left');
  });

  it('leaves the questions that do not apply out of the body but keeps them in the table', () => {
    // `standing === 'not-applicable'` survived becoming `!==`, which prints the one question that
    // does not apply and silently drops every question that does.
    const report = renderDecision('main...HEAD', decide(seen({ changedTests: [] })));
    const table = report.slice(0, report.indexOf('### '));
    assert.match(table, /Can the tests in this change fail\?/, 'the table lists it as n/a');
    assert.doesNotMatch(report, /### Can the tests in this change fail\?/, 'but it gets no section of its own');
    assert.match(report, /### Is everything passing/, 'and the questions that do apply still get theirs');
  });
});
