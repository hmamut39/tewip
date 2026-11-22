// Phase 24: one verdict on whether a piece of work is done.
//
// The whole value of this is that it can be relied on to say no, and to say "cannot say" instead of
// yes. So these tests are mostly about the shape of the refusals: that a broken check outranks a clean
// one, that an unanswered essential question is never rounded up to approval, that a verdict always
// lists what it says nothing about, and that the order is fixed so a person can predict it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gather } from '../verdict/verdict-command.ts';
import { decide, renderDecision, type Evidence } from '../verdict/verdict.ts';

const NL = String.fromCharCode(10);

/** A change with everything answered and nothing wrong: the only state that may be called ready. */
const sound: Evidence = {
  changedSource: ['src/refunds.js'],
  changedTests: ['tests/refunds.test.js'],
  covering: [{ testFile: 'tests/refunds.test.js', how: 'imports it' }],
  selfTested: [],
  importsNotFollowed: [],
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

  // Phase 123: the sentence a reviewer of agent-written code actually needs.
  //
  // "every deliberate change made to this code was caught" could be one mutant or forty, and the
  // reader had no way to tell which - an unquantified claim in the strongest row of the gate. It
  // is also a claim about *this change* now rather than about the file, because since Phase 120
  // the mutants are made on the lines the diff wrote instead of sampled across the whole file,
  // and the wording had not caught up with what the code does.
  it('says how many deliberate changes were caught, and that they were on this change', () => {
    const check = decide(seen({ unnoticed: [], proofsTried: 4 })).checks.find((c) => c.question === 'Would the tests catch a bug in this code?');
    assert.match(check?.answer ?? '', /all 4 deliberate change\(s\)/, 'a number, or the reader cannot weigh the claim');
    assert.match(check?.answer ?? '', /lines this change wrote/, 'about the change, not the file');
  });

  it('says how many slipped past, out of how many were tried', () => {
    const slipped = seen({ unnoticed: [{ file: 'src/refunds.js', line: 2, kind: 'a comparison inverted' }], proofsTried: 4 });
    const check = decide(slipped).checks.find((c) => c.question === 'Would the tests catch a bug in this code?');
    assert.match(check?.answer ?? '', /1 of 4 deliberate change\(s\)/, '1 of 4 and 1 of 40 are different findings');
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

// Phase 216. "Is the changed code tested?" is the row a release decision leans on, and its evidence
// was three bare filenames. A test that imports the changed file and one that arrives at it through
// six hops read identically, and a DTO half the project imports is "reached" by nearly every test.
describe('the evidence for "is the changed code tested"', () => {
  const reached = (covering: Evidence['covering']): string =>
    decide({ ...sound, covering }).checks.find((c) => c.question === 'Is the changed code tested?')?.answer ?? '';

  it('says how each named test reaches the change', () => {
    const answer = reached([
      { testFile: 'tests/a.test.js', how: 'imports it' },
      { testFile: 'tests/b.test.js', how: 'reaches it through 4 import(s)' },
    ]);
    assert.match(answer, /tests\/a\.test\.js \(imports it\)/, 'a direct importer must say so');
    assert.match(answer, /reaches it through 4 import\(s\)/, 'and a distant one must say how far');
  });

  it('names the direct importers first, because they are the stronger evidence', () => {
    // On immich's config.dto.ts the three it chose to name were exif specs reached through the
    // import graph, while the file's own config.dto.spec.ts was in the same list.
    const answer = reached([
      { testFile: 'tests/far-one.test.js', how: 'reaches it through 6 import(s)' },
      { testFile: 'tests/far-two.test.js', how: 'reaches it through 5 import(s)' },
      { testFile: 'tests/far-three.test.js', how: 'reaches it through 5 import(s)' },
      { testFile: 'tests/its-own.test.js', how: 'imports it' },
    ]);
    assert.match(answer, /tests\/its-own\.test\.js \(imports it\)/, 'the direct importer must be among the names');
    assert.doesNotMatch(answer, /far-three/, 'and must displace a distant one rather than be dropped');
  });

  it('still counts every covering test, not only the ones it names', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ testFile: `tests/t${i}.test.js`, how: 'imports it' }));
    assert.match(reached(many), /^9 test file\(s\) reach it/, 'the count is of all of them');
  });
});

// Phase 217. `done` kept a second list of what counts as source, written beside the one that
// actually judges code, and it was missing `.rs`, `.scala`, `.groovy`, `.kts` and `.fs`. On
// ripgrep the gate read three Rust test files, judged them, and two rows above said the question
// of whether the changed code is tested does not apply - one report, reading the tests of a change
// it had just called sourceless. Then, once Rust was visible, it said **"nothing here could notice
// a mistake in it"** about two files that each carry their own `#[cfg(test)] mod tests`.
//
// Measured through `gather` on a real repository rather than against a hand-built Evidence,
// because both halves of the defect were in the gathering. A fixture handing `decide` a
// `selfTested` array would pass with `gather` never filling it in.
describe('a language whose tests live in the file that changed', () => {
  const rustProject = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-rs-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(join(root, 'src'), { recursive: true });
    const before = [
      'pub fn strip(s: &str) -> String {',
      '    s.trim().to_string()',
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    use super::*;',
      '',
      '    #[test]',
      '    fn trims() {',
      '        assert_eq!(strip("  a  "), "a");',
      '    }',
      '}',
      '',
    ].join(NL);
    writeFileSync(join(root, 'src', 'strip.rs'), before, 'utf8');
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('add', '-A');
    git('commit', '-qm', 'first');
    writeFileSync(join(root, 'src', 'strip.rs'), before.replace('s.trim()', 's.trim_start()'), 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'trim only the start');
    return root;
  };

  const tested = (root: string) => {
    const got = gather({ root, diff: 'HEAD~1...HEAD' });
    const check = decide(got!.evidence).checks.find((c) => c.question === 'Is the changed code tested?');
    return { got: got!, check: check! };
  };

  it('counts a Rust file as source at all', () => {
    const { got } = tested(rustProject());
    assert.deepEqual(got.evidence.changedSource, ['src/strip.rs'], 'a .rs file the commit rewrote is source');
  });

  it('never calls a file carrying its own tests untested', () => {
    const { got, check } = tested(rustProject());
    assert.deepEqual(got.evidence.selfTested, ['src/strip.rs'], 'the #[cfg(test)] module in the changed file must be found');
    assert.notEqual(check.standing, 'not-met', 'a file with its own #[test] is the one answer the evidence rules out');
    assert.notEqual(check.standing, 'not-applicable', 'and the change is not sourceless either');
    assert.equal(check.standing, 'not-checked');
    assert.match(check.answer, /declare tests inside themselves/, 'and it must say why it cannot tell');
    assert.match(check.answer, /src\/strip\.rs/, 'naming the file it read them out of');
  });
});

// Phase 217. `src/Core/Constants.cs` was told "no test imports or reaches it, and this change adds
// no test either, so nothing here could notice a mistake in it", and the whole change was failed
// on it. 63 of bitwarden's test files name the types declared in that file. C# says `using
// Bit.Core;`; nothing Tewip looks for is in that line, and over the corpus not one import resolved
// in C#, Go, Java or Ruby - 1,958 keycloak test files, 1,173 bitwarden, 765 discourse, 0 hits.
describe('a language whose imports cannot be read', () => {
  const csharpProject = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-cs-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(join(root, 'src', 'Core'), { recursive: true });
    mkdirSync(join(root, 'test', 'Core.Test'), { recursive: true });
    const before = [
      'namespace Bit.Core;',
      '',
      'public static class Constants',
      '{',
      '    public const int MaxDevices = 10;',
      '}',
      '',
    ].join(NL);
    writeFileSync(join(root, 'src', 'Core', 'Constants.cs'), before, 'utf8');
    // A real test, naming the changed type the only way C# ever does.
    writeFileSync(
      join(root, 'test', 'Core.Test', 'ConstantsTests.cs'),
      ['using Bit.Core;', '', 'public class ConstantsTests', '{', '    [Fact]', '    public void Caps() => Assert.Equal(10, Constants.MaxDevices);', '}', ''].join(NL),
      'utf8',
    );
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('add', '-A');
    git('commit', '-qm', 'first');
    writeFileSync(join(root, 'src', 'Core', 'Constants.cs'), before.replace('= 10', '= 15'), 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'raise the cap');
    return root;
  };

  it('never says nothing could notice a mistake when it could not look', () => {
    const root = csharpProject();
    const got = gather({ root, diff: 'HEAD~1...HEAD' });
    assert.deepEqual(got!.evidence.changedSource, ['src/Core/Constants.cs']);
    assert.deepEqual(got!.evidence.covering, [], 'no C# import resolves, which is the whole point');
    assert.deepEqual(got!.evidence.importsNotFollowed, ['src/Core/Constants.cs'], 'and it must know that is why');
    const check = decide(got!.evidence).checks.find((c) => c.question === 'Is the changed code tested?')!;
    assert.notEqual(check.standing, 'not-met', 'a zero from a language it cannot read is not a zero');
    assert.equal(check.standing, 'not-checked');
    assert.doesNotMatch(check.answer, /nothing here could notice a mistake/, 'the sentence that failed bitwarden');
    assert.match(check.answer, /imports Tewip cannot read/, 'it must say which part of itself stopped');
    assert.match(check.answer, /coverage report/, 'and what the project can do about it');
  });

  it('still says no for a language it can read, where a zero really is a zero', () => {
    // The branch must not become a blanket excuse: in JavaScript and Python an unresolved import
    // means the test is not there, and the gate has to keep being able to say so.
    const check = decide({ ...sound, covering: [], changedTests: [], selfTested: [], importsNotFollowed: [] }).checks.find(
      (c) => c.question === 'Is the changed code tested?',
    )!;
    assert.equal(check.standing, 'not-met');
    assert.match(check.answer, /nothing here could notice a mistake in it/);
  });
});

// Phase 217. Two claims in the same report that the diff did not support.
//
// angular-components: all eight tests listed for `datepicker-input-base.ts` were printed as
// "(imports it)", and not one of them contains that string - they import
// `@angular/material/datepicker`, the front door of the folder. Phase 216 split "imports it" from
// "reaches it through N import(s)" so a reader could weigh the evidence; `importingTests` returned
// `imports` and `package` as one list and the caller labelled both of them "imports it".
//
// keycloak: the change was two `migration-realm-1.9.8.Final-Migration.json` resources sitting
// under `tests/base/src/test/resources/`, and the report said "Can the tests in this change fail?
// **Yes: every test in this change asserts something**". A path is not a language.
describe('what kind of evidence it is, and what counts as a test file', () => {
  const git = (root: string) => (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const commit = (root: string, message: string) => {
    const g = git(root);
    g('add', '-A');
    g('commit', '-qm', message);
  };

  const start = (root: string) => {
    const g = git(root);
    g('init', '-q');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'T');
  };

  it('does not call a package-level match "imports it"', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-pkg-'));
    mkdirSync(join(root, 'src', 'thing'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    const before = 'export const base = (n) => n + 1;' + NL;
    writeFileSync(join(root, 'src', 'thing', 'base.js'), before, 'utf8');
    writeFileSync(join(root, 'src', 'thing', 'index.js'), "export * from './base.js';" + NL, 'utf8');
    // Imports the folder, never the file. This is the shape of all eight angular-components tests.
    writeFileSync(
      join(root, 'tests', 'thing.test.js'),
      "import { base } from '../src/thing';" + NL + "it('adds', () => { expect(base(1)).toBe(2); });" + NL,
      'utf8',
    );
    start(root);
    commit(root, 'first');
    writeFileSync(join(root, 'src', 'thing', 'base.js'), before.replace('n + 1', 'n + 2'), 'utf8');
    commit(root, 'change the base');

    const got = gather({ root, diff: 'HEAD~1...HEAD' });
    assert.deepEqual(got!.evidence.changedSource, ['src/thing/base.js']);
    const reach = got!.evidence.covering.find((c) => c.testFile === 'tests/thing.test.js');
    assert.ok(reach, 'the test does reach the change, through the front door');
    assert.equal(reach!.how, 'imports the package it is in', 'and must not claim it names the file');
    assert.notEqual(reach!.how, 'imports it');
  });

  it('names a file that really imports the change before one that imports its folder', () => {
    const answer = decide({
      ...sound,
      covering: [
        { testFile: 'tests/far.test.js', how: 'reaches it through 5 import(s)' },
        { testFile: 'tests/pkg.test.js', how: 'imports the package it is in' },
        { testFile: 'tests/own.test.js', how: 'imports it' },
      ],
    }).checks.find((c) => c.question === 'Is the changed code tested?')!.answer;
    assert.match(answer, /own\.test\.js \(imports it\).*pkg\.test\.js \(imports the package/, 'strongest first');
    assert.ok(answer.indexOf('pkg.test.js') < answer.indexOf('far.test.js'), 'and a folder import beats a distant one');
  });

  it('does not count a JSON file under a test folder as a test', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-res-'));
    mkdirSync(join(root, 'tests', 'resources'), { recursive: true });
    writeFileSync(join(root, 'tests', 'resources', 'migration-realm-Migration.json'), '{ "realm": "a" }' + NL, 'utf8');
    start(root);
    commit(root, 'first');
    writeFileSync(join(root, 'tests', 'resources', 'migration-realm-Migration.json'), '{ "realm": "b" }' + NL, 'utf8');
    commit(root, 'change the resource');

    const got = gather({ root, diff: 'HEAD~1...HEAD' });
    assert.deepEqual(got!.evidence.changedTests, [], 'a JSON resource is not a test, wherever it sits');
    const check = decide(got!.evidence).checks.find((c) => c.question === 'Can the tests in this change fail?')!;
    assert.equal(check.standing, 'not-applicable', 'so there is nothing to say about tests that are not there');
    assert.doesNotMatch(check.answer, /every test in this change asserts something/, 'the sentence keycloak got');
  });
});
