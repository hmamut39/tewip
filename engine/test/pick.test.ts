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
