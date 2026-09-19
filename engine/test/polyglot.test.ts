// Real reports written by real test runners (fixtures/polyglot, produced by the polyglot-fixtures
// workflow): one per language and framework. Each project has the same tests, so each report must
// read the same way. This pins down what was verified, so a change cannot silently break a stack.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { diagnoseRecords } from '../engine.ts';
import { valueMismatch } from '../error-parse.ts';
import { HistoryIndex } from '../history.ts';
import { importJunit } from '../import/junit.ts';
import { PROJECT_ROOT } from '../../reporters/store.ts';

const REPORTS = join(PROJECT_ROOT, 'fixtures', 'polyglot', 'reports');

/** Report file -> the runner that wrote it, and whether that runner records retries. */
const RUNNERS: Array<{ file: string; runner: string; retries: boolean }> = [
  { file: 'node-node-test.xml', runner: 'node:test (built-in)', retries: false },
  { file: 'node-jest.xml', runner: 'Jest (jest-junit)', retries: false },
  { file: 'node-vitest.xml', runner: 'Vitest', retries: false },
  { file: 'node-mocha.xml', runner: 'Mocha (mocha-junit-reporter)', retries: false },
  { file: 'python-pytest.xml', runner: 'pytest + pytest-rerunfailures', retries: true },
  { file: 'java-TEST-shop.ShopTest.xml', runner: 'Maven Surefire (JUnit 5)', retries: true },
  { file: 'go-go.xml', runner: 'Go (gotestsum)', retries: false },
  { file: 'dotnet-dotnet.trx', runner: '.NET (TRX)', retries: false },
  { file: 'dotnet-dotnet-junit.xml', runner: '.NET (JunitXml.TestLogger)', retries: false },
  { file: 'ruby-rspec.xml', runner: 'RSpec', retries: false },
  { file: 'php-phpunit.xml', runner: 'PHPUnit', retries: false },
  { file: 'rust-junit.xml', runner: 'Rust (cargo-nextest)', retries: false },
];

function read(file: string) {
  const { records, summary } = importJunit(join(REPORTS, file), { runId: 'r1', gitSha: 'abc', workspace: '/home/runner/work/triage-agent/triage-agent' });
  const diagnoses = diagnoseRecords(records, new HistoryIndex(records, [summary]));
  const last = (pattern: RegExp) => {
    const i = records.map((r) => pattern.test(r.testId)).lastIndexOf(true);
    return i < 0 ? null : { record: records[i], diagnosis: diagnoses[i], attempts: summary.attempts[records[i].testId] };
  };
  return { records, summary, last };
}

describe('real reports from every supported runner', () => {
  for (const { file, runner, retries } of RUNNERS) {
    describe(runner, () => {
      const { summary, last } = read(file);

      it('counts every test, passing ones included, so history has the passes', () => {
        assert.ok(Object.keys(summary.attempts).length >= 3, `only ${Object.keys(summary.attempts).length} tests read`);
      });

      it('reads the wrong value in the failure (expected 4, got 3)', () => {
        const wrong = last(/total/i);
        assert.ok(wrong, 'the failing "total" test is missing');
        assert.deepEqual(valueMismatch(wrong.record.errorMessage), { expected: '4', received: '3' });
      });

      it('calls an unreachable service ENV', () => {
        const down = last(/pricing/i);
        assert.ok(down, 'the failing "pricing service" test is missing');
        assert.equal(down.diagnosis.category, 'ENV');
      });

      if (retries) {
        it('calls a test that failed once and passed on the retry TIMING', () => {
          const flaky = last(/flaky/i);
          assert.ok(flaky, 'the flaky test is missing');
          assert.equal(flaky.attempts, 2);
          assert.equal(flaky.diagnosis.category, 'TIMING');
        });

        it('calls a wrong value that failed on every attempt REAL_BUG', () => {
          assert.equal(last(/total/i)?.diagnosis.category, 'REAL_BUG');
        });
      }
    });
  }

  it('makes absolute paths relative to the checkout, so a test has the same id on every machine', () => {
    const { records } = read('node-node-test.xml');
    assert.ok(records.length > 0);
    for (const r of records) assert.ok(r.testId.startsWith('fixtures/polyglot/node/node-test.test.mjs'), r.testId);
  });
});
