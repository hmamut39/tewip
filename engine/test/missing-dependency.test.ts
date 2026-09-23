// A test that could not be loaded at all. Every case here comes from running a stranger's suite:
// humanize's pytest run produced six "ImportError while importing test module" entries, and then,
// once its dependencies were installed, fifteen more reading "fixture 'benchmark' not found".
// Tewip answered UNKNOWN to all of them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { envMissingDependency, fixtureMissing, missingDependency } from '../missing-dependency.ts';
import type { RunContext } from '../history.ts';
import type { TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);
const failure = (message: string): TriageRecord => ({ testId: 't', errorMessage: message }) as unknown as TriageRecord;
const run = (...messages: string[]): RunContext => ({ runId: 'r', branch: '', testsAttempted: messages.length, failures: messages.map(failure) }) as RunContext;

const decide = (message: string, context = run(message)) =>
  envMissingDependency.evaluate({ record: failure(message), history: {} as never, run: context, loadSnapshot: () => null });

describe('a module that could not be loaded', () => {
  it('reads the name out of each language runner', () => {
    assert.deepEqual(missingDependency("ModuleNotFoundError: No module named 'freezegun'"), { language: 'Python', module: 'freezegun' });
    assert.deepEqual(missingDependency("Error: Cannot find module 'lodash'"), { language: 'Node', module: 'lodash' });
    assert.deepEqual(missingDependency('java.lang.NoClassDefFoundError: org.junit.Assert'), { language: 'Java', module: 'org.junit.Assert' });
    assert.deepEqual(missingDependency('LoadError: cannot load such file -- rails_helper'), { language: 'Ruby', module: 'rails_helper' });
  });

  it('calls it the environment, because no test code ran', () => {
    const outcome = decide("ImportError while importing test module.  ModuleNotFoundError: No module named 'freezegun'");
    assert.equal(outcome?.category, 'ENV');
    assert.match(outcome!.evidence[0].message, /a dependency is missing|dependencies were not installed/);
  });

  it('is surer when every failure in the run is the same kind', () => {
    const messages = ["No module named 'freezegun'", "No module named 'freezegun'", "No module named 'pytest_cov'"].map((m) => `ModuleNotFoundError: ${m}`);
    const outcome = decide(messages[0], run(...messages));
    assert.equal(outcome?.confidence, 0.92);
    assert.match(outcome!.evidence[0].message, /every failure in this run/);
  });

  it('leaves a module belonging to the project alone, because that is a real bug', () => {
    // A rename that missed a caller is not the machine's fault.
    assert.equal(missingDependency("ModuleNotFoundError: No module named 'src.checkout.totals'"), null);
    assert.equal(missingDependency("Cannot find module './helpers/cart'"), null);
  });

  it('leaves a file that will not parse alone, for the same reason', () => {
    assert.equal(missingDependency(`SyntaxError: invalid syntax${NL}ModuleNotFoundError: No module named 'x'`), null);
    assert.equal(missingDependency("TypeError: bad operand. Cannot find module 'x'"), null);
  });
});

describe('a fixture nothing can provide', () => {
  it('reads the fixture name', () => {
    assert.equal(fixtureMissing("E       fixture 'benchmark' not found"), 'benchmark');
    assert.equal(fixtureMissing('everything was fine'), null);
  });

  it('calls it the environment when several tests all want the same missing fixture', () => {
    const messages = Array.from({ length: 15 }, () => "fixture 'benchmark' not found");
    const outcome = decide(messages[0], run(...messages));
    assert.equal(outcome?.category, 'ENV');
    assert.match(outcome!.evidence[0].message, /15 tests in this run all need the fixture "benchmark"/);
  });

  it('says nothing when only one test wants it, because a typo reads the same', () => {
    assert.equal(decide("fixture 'benchmrk' not found", run("fixture 'benchmrk' not found")), null);
    assert.equal(decide("fixture 'a' not found", run("fixture 'a' not found", "fixture 'b' not found")), null);
  });
});
