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
import { vouchFile } from '../vouch/vouch.ts';
import { looksLikeTests } from '../vouch/tests-in.ts';

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

// Phase 48: Ruby, PHP and Rust, added in Phase 36 and never measured on real code until now.
// discourse (54,846 Ruby tests), firefly-iii (86 PHP tests) and ripgrep (466 Rust tests).
describe('PHP: what makes a method a PHPUnit test', () => {
  const php = (body: string, file = 'SomethingTest.php') => vouchFile(file, body);

  it('does not read a production method named test* as a test', () => {
    // firefly-iii has `private function testing()` in middleware - asking whether the app is in the
    // test environment - and eight public `testRule` / `testNotification` endpoints in controllers,
    // which a user hits to try a rule or send a test notification. Every one made its production
    // class a test file. What makes a PHPUnit test is the class it is in.
    const controller = [
      '<?php',
      'final class TriggerController extends Controller {',
      '  public function testRule(TestRequest $request): JsonResponse {',
      '    return response()->json([]);',
      '  }',
      '}',
    ].join('\n');
    assert.equal(php(controller, 'app/Http/Controllers/TriggerController.php').judgements.length, 0);
    assert.match(php(controller, 'app/Http/Controllers/TriggerController.php').unread, /different question|does not look like/);
  });

  it('still reads a real PHPUnit test', () => {
    const test = [
      '<?php',
      'final class AccountControllerTest extends TestCase {',
      '  public function testItWorks(): void {',
      '    $this->assertSame(1, 1);',
      '  }',
      '}',
    ].join('\n');
    assert.equal(php(test).judgements.length, 1);
  });

  it('reads Laravel fluent assertions, which is what a Laravel HTTP test asserts with', () => {
    // `$response->assertUnauthorized()` was an unknown helper that might assert, so firefly-iii came
    // back 72% "Tewip would not judge" - 68 of its 95 tests.
    const test = [
      '<?php',
      'final class AccountControllerTest extends TestCase {',
      '  public function testUnauthenticated(): void {',
      '    $response = $this->get(route("api.v1.autocomplete.accounts"));',
      '    $response->assertUnauthorized();',
      '    $response->assertHeader("Content-Type", "application/json");',
      '  }',
      '}',
    ].join('\n');
    assert.equal(php(test).judgements[0]?.verdict, 'checks');
  });
});

describe('a file nobody in this project wrote', () => {
  it('does not judge minified or vendored code', () => {
    // firefly-iii ships jquery-4.0.0.min.js, and minified JavaScript is full of `test(` because
    // that is how a regular expression is applied. Nothing useful can come of judging it.
    const minified = `!function(e){var t=/^x$/;t.test(e)&&function(){}()}(window);${'a'.repeat(2500)}`;
    assert.equal(looksLikeTests('public/v1/lib/jquery-4.0.0.min.js', minified), false);
    assert.equal(looksLikeTests('vendor/some/bundle.js', 'it("x", () => { expect(1).toBe(1); });'), false);
    // and an ordinary test file is still a test file
    assert.equal(looksLikeTests('spec/thing_spec.rb', 'it "works" do\n  expect(1).to eq(1)\nend'), true);
  });
});

describe('Ruby: a skip that carries a condition', () => {
  const rspec = (body: string) => vouchFile('thing_spec.rb', `RSpec.describe Thing do\n${body}\nend`);

  it('does not call a conditionally skipped test "never runs"', () => {
    // discourse writes `skip "..." if suggested_topic.nil?` - the test runs every time the condition
    // is false, which is most of the time. 30 of its 37 "never runs" findings were this.
    const conditional = [
      '  it "includes gists in suggested topics" do',
      '    suggested = find_suggested',
      '    skip "suggested topic not found in results" if suggested.nil?',
      '    expect(suggested.gist).to eq("x")',
      '  end',
    ].join('\n');
    assert.equal(rspec(conditional).judgements[0]?.verdict, 'checks');
  });

  it('still catches an unconditional skip', () => {
    const always = '  it "is off" do\n    skip "broken"\n    expect(1).to eq(1)\n  end';
    assert.equal(rspec(always).judgements[0]?.verdict, 'never-runs');
  });
});

describe('Ruby: an expectation kept in a variable', () => {
  it('is finished when the matcher is called on the variable', () => {
    // RSpec allows it and discourse writes it. `expect(...)` returns the target and `.to` is a
    // method on it, so this is a finished expectation that happens to span three lines.
    const held = [
      'RSpec.describe Onebox do',
      '  it "allows both start and end" do',
      '    preview =',
      '      expect(Onebox.preview("https://x").to_s)',
      '    preview.to match(/start=120/)',
      '    preview.to match(/end=180/)',
      '  end',
      'end',
    ].join('\n');
    assert.equal(vouchFile('youtube_onebox_spec.rb', held).judgements[0]?.verdict, 'checks');
  });

  it('still catches an expectation nothing was ever called on', () => {
    const bare = 'RSpec.describe Onebox do\n  it "x" do\n    expect(Onebox.preview("https://x").to_s)\n  end\nend';
    assert.equal(vouchFile('youtube_onebox_spec.rb', bare).judgements[0]?.verdict, 'unfinished-expectation');
  });
});
