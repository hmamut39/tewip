// Phase 25: narrowing a test run. Every test here is about a refusal, because a selection tool has one
// failure that matters - dropping the test that would have caught the bug - and the only defence against
// it is to narrow nothing unless the evidence is a fact about the source.
//
// Several of these cases are mistakes this made on real projects before the rules were written: express's
// 86 test files declared unaffected by a change to the response code, this project's own command line
// forcing a full suite because nothing imports it, and a repository-scanning guard being skipped when any
// file at all can break it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pick, renderPick, type Candidate, type PickInput } from '../pick/pick.ts';
import { nothingToJudge } from '../../eval/pick-safety.ts';

const NL = String.fromCharCode(10);

const tests = (...names: string[]): Candidate[] => names.map((testFile) => ({ testFile, recentlyFailed: [] }));

const input = (over: Partial<PickInput> = {}): PickInput => ({
  changed: ['src/cart.js'],
  tests: tests('tests/cart.test.js', 'tests/user.test.js', 'tests/billing.test.js'),
  reaching: new Map([['src/cart.js', [{ testFile: 'tests/cart.test.js', how: 'imports' }]]]),
  browserTests: false,
  noHistory: false,
  unreferenced: [],
  ...over,
});

describe('which tests could notice a change', () => {
  it('keeps the tests that import the changed file and leaves the rest', () => {
    const picked = pick(input());
    assert.equal(picked.runEverything, '');
    assert.deepEqual(picked.mustRun.map((m) => m.testFile), ['tests/cart.test.js']);
    assert.deepEqual(picked.skipped.map((s) => s.testFile), ['tests/billing.test.js', 'tests/user.test.js']);
    assert.match(picked.mustRun[0].why, /imports src\/cart\.js/);
  });

  it('always runs a test the change itself edits', () => {
    const picked = pick(input({ changed: ['src/cart.js', 'tests/user.test.js'] }));
    const must = picked.mustRun.map((m) => m.testFile);
    assert.ok(must.includes('tests/user.test.js'));
    assert.match(picked.mustRun.find((m) => m.testFile === 'tests/user.test.js')!.why, /this change edits it/);
  });

  it('always runs a test that has been failing lately, because an unknown is not a skip', () => {
    const candidates = tests('tests/cart.test.js', 'tests/user.test.js');
    candidates[1].recentlyFailed = ['user > signs in'];
    const picked = pick(input({ tests: candidates }));
    assert.ok(picked.mustRun.some((m) => m.testFile === 'tests/user.test.js'));
    assert.match(picked.mustRun.find((m) => m.testFile === 'tests/user.test.js')!.why, /unknown rather than unrelated/);
  });

  it('always runs a test that reads the repository, because any file can break it', () => {
    // This project's own control-character guard walks every source file. A change to a module it does
    // not import really does fail it, which a safety measurement found the hard way.
    const candidates = tests('tests/cart.test.js', 'tests/source-guard.test.js');
    candidates[1].readsTheRepo = true;
    const picked = pick(input({ tests: candidates }));
    assert.ok(picked.mustRun.some((m) => m.testFile === 'tests/source-guard.test.js'));
    assert.match(picked.mustRun.find((m) => m.testFile === 'tests/source-guard.test.js')!.why, /reads the repository/);
  });
});

describe('when it refuses to narrow', () => {
  it('runs everything when the dependencies changed', () => {
    for (const file of ['package-lock.json', 'requirements.txt', 'go.sum', 'pom.xml']) {
      const picked = pick(input({ changed: [file] }));
      assert.match(picked.runEverything, /dependencies/, `${file} should stop selection`);
    }
  });

  it('runs everything when the build or the test configuration changed', () => {
    for (const file of ['.github/workflows/ci.yml', 'jest.config.js', 'playwright.config.ts', 'Dockerfile', 'tsconfig.json']) {
      const picked = pick(input({ changed: [file] }));
      assert.ok(picked.runEverything, `${file} should stop selection`);
    }
  });

  it('runs everything when shared setup or a fixture changed', () => {
    for (const file of ['tests/conftest.py', 'test/support/utils.js', 'tests/fixtures/orders.json', 'jest.setup.ts']) {
      const picked = pick(input({ changed: [file] }));
      assert.ok(picked.runEverything, `${file} should stop selection`);
    }
  });

  it('runs everything when a changed file cannot be traced to any test', () => {
    const picked = pick(input({ reaching: new Map([['src/cart.js', []]]) }));
    assert.match(picked.runEverything, /no test can be traced to src\/cart\.js/);
    assert.match(picked.runEverything, /dependency injection|dynamic import/);
    assert.deepEqual(picked.opaque, ['src/cart.js']);
  });

  it('says plainly that a browser suite cannot be narrowed by imports', () => {
    // A test that drives a browser reaches the code through the running application, so its imports say
    // nothing about what it exercises. Narrowing on that basis would be a guess dressed as a fact.
    const picked = pick(input({ reaching: new Map([['src/cart.js', []]]), browserTests: true }));
    assert.match(picked.runEverything, /drive a browser/);
    assert.match(picked.runEverything, /would be a guess/);
  });

  it('does not force a full suite over a file nothing in the project refers to', () => {
    // The opposite mistake, and it made the command useless on its first real run: a change to this
    // project's command line, which tests only read as text, stopped all narrowing.
    const picked = pick(input({ reaching: new Map([['src/cart.js', []]]), unreferenced: ['src/cart.js'] }));
    assert.equal(picked.opaque.length, 0);
    assert.match(picked.runEverything, /nothing in this project refers to/);
  });

  it('says there is nothing to skip rather than claiming a saving', () => {
    const picked = pick(
      input({
        tests: tests('tests/cart.test.js'),
        reaching: new Map([['src/cart.js', [{ testFile: 'tests/cart.test.js', how: 'imports' }]]]),
      }),
    );
    assert.match(picked.runEverything, /nothing to skip/);
  });

  it('treats a documentation-only change as affecting no test', () => {
    const picked = pick(input({ changed: ['README.md', 'docs/guide.mdx', 'logo.png'] }));
    assert.match(picked.runEverything, /only documentation, assets/);
  });
});

describe('the report', () => {
  it('states the saving, the command and what is being given up', () => {
    const report = renderPick(pick(input()), 3, 'npx jest tests/cart.test.js', false);
    assert.match(report, /1 of 3 test file\(s\)/);
    assert.match(report, /npx jest tests\/cart\.test\.js/);
    assert.match(report, /What you are giving up \(2\)/);
    assert.match(report, /a fact about the source, not a prediction/);
  });

  it('explains a refusal instead of printing an empty selection', () => {
    const report = renderPick(pick(input({ changed: ['package.json'] })), 3, 'npm test', false);
    assert.match(report, /Run the whole suite/);
    assert.doesNotMatch(report, /giving up/);
    assert.match(report, /not asking you to take the risk/);
  });

  it('admits when it could not check whether a test has been failing lately', () => {
    const report = renderPick(pick(input({ noHistory: true })), 3, 'npm test', true);
    assert.match(report, /keeps no run history/);
  });

  it('says the choice is a fact rather than a prediction, and that no model was called', () => {
    const report = renderPick(pick(input()), 3, 'npm test', false);
    assert.match(report, /No model is called/);
    assert.match(report, /not a prediction/);
  });
});

// Phase 52: `pick` measured against five real merged Saleor pull requests.
//
// It narrowed 1,229 test files to one and called the other 1,228 "left out because of a fact about
// the source, not a prediction". The fact was wrong.
describe('whether anything in the project refers to a file', () => {
  it('asks for the module name, not the file name', () => {
    // The reference check searched for the basename *with its extension*, which is a JavaScript
    // habit: a JS import often writes `./sorting.js` and nothing else does. Python writes
    // `from ..utils.sorting import x`, Java `import com.x.Sorting`, C# `using X.Sorting`.
    //
    //   git grep -l -- "sorting.py"   ->  0 files
    //   git grep -l -- "sorting"      ->  61 files
    //
    // Nothing matched, so the file counted as referenced nowhere - the one condition that lets
    // selection proceed past a source file no test imports.
    const nameFor = (file: string) => {
      const base = file.split('/').pop() ?? '';
      return base.replace(/\.[A-Za-z0-9]+$/, '') || base;
    };
    assert.equal(nameFor('saleor/graphql/utils/sorting.py'), 'sorting');
    assert.equal(nameFor('src/Core/Settings/GlobalSettings.cs'), 'GlobalSettings');
    assert.equal(nameFor('app/models/user.rb'), 'user');
    // a dotfile keeps its name rather than becoming empty
    assert.equal(nameFor('.eslintrc'), '.eslintrc');
  });
});

describe('refusing to narrow', () => {
  const base = { tests: tests('tests/a.test.ts', 'tests/b.test.ts'), browserTests: false, noHistory: true };

  it('runs everything when a changed file can be traced to no test', () => {
    // saleor/graphql/utils/sorting.py is shared GraphQL sorting code that every sortBy query runs
    // through, and the suite has dozens of sorting test files. Skipping them on the strength of an
    // import graph that cannot see a resolver chain is exactly the risk this command exists not to
    // take - and its own report called the exclusions facts.
    const picked = pick({
      ...base,
      changed: ['src/sorting.ts'],
      reaching: new Map(),
      unreferenced: [],
    });
    assert.match(picked.runEverything, /no test can be traced to src\/sorting\.ts/);
    assert.deepEqual(picked.opaque, ['src/sorting.ts']);
  });

  it('still narrows when the tests really can be traced', () => {
    // A selector that always says "run everything" is no selector. On Tewip's own TypeScript, where
    // imports do carry the name, it still picks 2 files out of 91.
    const picked = pick({
      ...base,
      changed: ['src/sorting.ts'],
      reaching: new Map([['src/sorting.ts', [{ testFile: 'tests/a.test.ts', how: 'imports' }]]]),
      unreferenced: [],
    });
    assert.equal(picked.runEverything, '');
    assert.deepEqual(picked.mustRun.map((m) => m.testFile), ['tests/a.test.ts']);
    assert.deepEqual(picked.skipped.map((s) => s.testFile), ['tests/b.test.ts']);
  });

  it('separates "nothing refers to it" from "nothing could be traced"', () => {
    // The exception this was built for. A file nothing refers to anywhere cannot be noticed by any
    // test, and treating that as "cannot tell" forced the whole suite on every dispatcher change.
    // It is still said out loud rather than narrowed around silently - and it says the opposite
    // thing from the untraceable case, which is what makes the distinction worth keeping.
    const picked = pick({ ...base, changed: ['src/orphan.ts'], reaching: new Map(), unreferenced: ['src/orphan.ts'] });
    assert.match(picked.runEverything, /nothing in this project refers to src\/orphan\.ts/);
    assert.deepEqual(picked.opaque, [], 'not an untraceable file: a file nothing names');
  });
});

// Phase 73: the safety number this project publishes for `pick` was re-derived rather than trusted.
// It held - 9 judged changes, **0** catching tests lost, 5.7% of the suite selected, better than the
// 7-9% in the README because the suite grew while the selection stayed targeted. Then the harness
// itself was asked what it says when it learns nothing.
describe('what the safety measurement claims when it measured nothing', () => {
  const judgedCase = { file: 'a.ts', line: 1, kind: 'k', caughtBy: ['test/a.test.ts'], selected: ['test/a.test.ts'], everything: '', share: 0.1 };
  const blindCase = { ...judgedCase, caughtBy: [] };

  it('refuses when every change was reported as caught by nothing', () => {
    // It printed "Narrowed, and the catching test was lost: **0**" followed by "No change that the
    // suite catches was lost by the selection", and exited 0: a clean safety verdict from zero
    // evidence. The comment above the output parser records this happening once already, when only
    // TAP was read - the parser was fixed and the report was never taught to say so.
    const why = nothingToJudge([blindCase, blindCase], []);
    assert.match(why, /all 2 change\(s\) were reported as caught by nothing/);
    assert.match(why, /the suite's output could not be read/);
    assert.match(why, /establishes nothing about safety either way/);
  });

  it('refuses when no change was made at all', () => {
    assert.match(nothingToJudge([], []), /no change was made at all/);
  });

  it('says nothing when there is something real to judge', () => {
    assert.equal(nothingToJudge([judgedCase, blindCase], [judgedCase]), '', 'one judgeable change is enough to report on');
  });
});
