// Phase 53: reading a coverage report the project already produces.
//
// Everything else in Tewip follows imports to decide what a test reaches, and Phases 46 and 52 hit
// the same wall twice: a test that posts a GraphQL query never imports the resolver chain it runs
// through. `done` answered "cannot say" on every real Saleor pull request and `pick` refused to
// narrow - honest both times, useless to a Python or Rails team. A coverage report records what ran.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { describesThisProject, findCoverage, readLcov, readXml, wasExecuted } from '../coverage/read-coverage.ts';
import { coverageFor, familyOf, importsCanBeFollowed, testFiles, testFilesFound } from '../review/coverage.ts';

const NL = String.fromCharCode(10);
import { decide, type Evidence } from '../verdict/verdict.ts';

describe('the four formats CI actually writes', () => {
  it('reads lcov, which is what a JavaScript or Rust suite leaves behind', () => {
    const text = 'TN:\nSF:engine/pick/pick.ts\nDA:1,1\nDA:2,0\nDA:3,4\nend_of_record\n';
    const { executed, mentioned } = readLcov(text);
    assert.deepEqual([...mentioned], ['engine/pick/pick.ts']);
    assert.deepEqual([...(executed.get('engine/pick/pick.ts') ?? [])], [1, 3], 'a line with no hits did not run');
  });

  it('reads Cobertura, which is what pytest-cov and coverlet write', () => {
    const xml = '<coverage><packages><package name="x"><classes><class filename="saleor/graphql/utils/sorting.py"><lines><line number="10" hits="3"/><line number="11" hits="0"/></lines></class></classes></package></packages></coverage>';
    const { executed } = readXml(xml);
    assert.deepEqual([...(executed.get('saleor/graphql/utils/sorting.py') ?? [])], [10]);
  });

  it('reads JaCoCo, and joins the package back onto the bare file name', () => {
    // JaCoCo names the package separately and the sourcefile without its directory. Without joining
    // them every file reads as a bare name that matches nothing in the diff.
    const xml = '<report><package name="org/keycloak/util"><sourcefile name="PemUtils.java"><line nr="41" mi="0" ci="4"/><line nr="42" mi="2" ci="0"/></sourcefile></package></report>';
    const { executed, mentioned } = readXml(xml);
    assert.deepEqual([...mentioned], ['org/keycloak/util/PemUtils.java']);
    assert.deepEqual([...(executed.get('org/keycloak/util/PemUtils.java') ?? [])], [41]);
  });

  it('reads Clover, which is what PHPUnit writes', () => {
    const xml = '<coverage><project><file path="src/Cart.php"><line num="8" type="stmt" count="2"/><line num="9" type="stmt" count="0"/></file></project></coverage>';
    const { executed } = readXml(xml);
    assert.deepEqual([...(executed.get('src/Cart.php') ?? [])], [8]);
  });
});

describe('a report that is not about this project', () => {
  it('is refused, rather than read as "nothing here is tested"', () => {
    // A stale report from another checkout would otherwise produce the confident wrong answer this
    // whole exercise exists to avoid: every changed file "in the report with no line executed".
    const root = mkdtempSync(join(tmpdir(), 'tewip-cov-'));
    writeFileSync(join(root, 'real.ts'), 'export const x = 1;\n');
    const elsewhere = readXml('<coverage><packages><package name="p"><classes><class filename="some/other/project/a.py"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>');
    assert.equal(describesThisProject({ from: 'coverage.xml', ...elsewhere }, root), false);
    const here = readXml('<coverage><packages><package name="p"><classes><class filename="real.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>');
    assert.equal(describesThisProject({ from: 'coverage.xml', ...here }, root), true);
  });

  it('finds the report where the tool that wrote it puts one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-cov-'));
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'src.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'coverage', 'lcov.info'), 'SF:src.ts\nDA:1,1\nend_of_record\n');
    const found = findCoverage(root);
    assert.equal(found?.from, 'coverage/lcov.info');
    assert.equal(wasExecuted(found!, 'src.ts'), true);
  });
});

describe('the verdict, once a coverage report is there', () => {
  const sound: Evidence = {
    changedSource: ['saleor/graphql/utils/sorting.py'],
    changedTests: ['saleor/graphql/product/tests/test_sorting.py'],
    covering: [],
    selfTested: [],
    importsNotFollowed: [],
    testsStoppedEarly: false,
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

  it('answers the question imports could not', () => {
    // On every real Saleor pull request this read "cannot say", because coverage was followed
    // through imports and the test reaches the code through a GraphQL resolver.
    const decision = decide({ ...sound, coverage: { from: 'coverage.xml', executed: ['saleor/graphql/utils/sorting.py'], notExecuted: [] } });
    const check = decision.checks.find((c) => c.question === 'Is the changed code tested?');
    assert.equal(check?.standing, 'met');
    assert.match(check?.answer ?? '', /the suite executes/);
    assert.match(check?.decidedBy ?? '', /records what ran rather than what imports what/);
  });

  it('says not ready when the report shows the code never running', () => {
    const decision = decide({ ...sound, coverage: { from: 'coverage.xml', executed: [], notExecuted: ['saleor/graphql/utils/sorting.py'] } });
    assert.equal(decision.verdict, 'not-ready');
    assert.match(decision.headline, /no line executed/);
  });

  it('falls back to "cannot say" when there is no report at all', () => {
    const decision = decide(sound);
    const check = decision.checks.find((c) => c.question === 'Is the changed code tested?');
    assert.equal(check?.standing, 'not-checked');
  });
});

// Phase 217. `importNames` reduces a file to its basename, so `lib/json_api_kit/url.rb` is looked
// for as `url` - and discourse has 752 JavaScript test files, eight of which import something
// ending in `url`. All eight were reported as importing the Ruby file, under "Yes: 8 test file(s)
// reach it (imports it)". `plugins/discourse-post-voting/plugin.rb` was covered by
// `uppy-checksum-plugin-test.js` on the same rule. A JavaScript file cannot import a Ruby one.
describe('a test can only cover a file its own language can import', () => {
  const mixed = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-mixed-'));
    mkdirSync(join(root, 'lib'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'lib', 'url.rb'), 'module Url' + NL + '  def self.join(a, b) = "#{a}#{b}"' + NL + 'end' + NL, 'utf8');
    writeFileSync(join(root, 'lib', 'url.js'), 'export const join = (a, b) => a + b;' + NL, 'utf8');
    writeFileSync(
      join(root, 'tests', 'url.test.js'),
      "import { join } from '../lib/url';" + NL + "it('joins', () => { expect(join('a', 'b')).toBe('ab'); });" + NL,
      'utf8',
    );
    return root;
  };

  it('does not let a JavaScript test import a Ruby file of the same name', () => {
    const root = mixed();
    const tests = [join(root, 'tests', 'url.test.js')];
    const strong = (file: string) => coverageFor(root, [file], tests).filter((c) => c.how !== 'name');
    assert.equal(strong('lib/url.js').length, 1, 'the JavaScript file of that name really is imported');
    assert.deepEqual(strong('lib/url.rb'), [], 'and the Ruby file of that name is not, whatever its basename');
  });

  it('knows which languages express an import as something it can read', () => {
    // Measured on the corpus: 0 of 25 sampled files resolved in keycloak (1,958 test files),
    // bitwarden (1,173), gin (38) or discourse (765). Only these two ever did.
    assert.equal(importsCanBeFollowed('src/a.ts'), true);
    assert.equal(importsCanBeFollowed('src/a.py'), true);
    for (const file of ['src/a.cs', 'src/a.go', 'src/A.java', 'src/a.rb', 'src/a.php', 'src/a.rs'])
      assert.equal(importsCanBeFollowed(file), false, `${file} has no import this can follow`);
  });

  it('puts a Vue or Svelte file in the JavaScript family, because it imports like one', () => {
    assert.equal(familyOf('src/a.vue'), 'js');
    assert.equal(familyOf('src/a.svelte'), 'js');
    assert.equal(familyOf('src/a.tsx'), 'js');
    assert.equal(familyOf('README.md'), null, 'and a document is in no family at all');
  });
});

// Phase 218. The function that decides what is allowed to cover a change could not see three of
// the languages Tewip reads. On the corpus it found 0 of discourse's 4,104 Ruby specs - the 765 it
// did find there are all JavaScript - 0 of firefly-iii's 38 PHP tests and 0 of ripgrep's 18 Rust
// ones, while Java, Go and C# it found. Ruby has been in `languageOf` since Phase 36, and `vouch`
// reads discourse's 54,136 assertions on every corpus run.
//
// It was wrong in both directions at once. 24 of firefly's 46 were thrown away because the
// directory rule excludes a path containing `Support` - which there is `app/Support/`, the subject
// under test - and eleven Laravel production classes counted as tests because they sit under
// `app/Events/Test/`, the feature that sends a user a test notification.
describe('finding the test files of a language other than JavaScript', () => {
  const write = (root: string, rel: string, text: string): string => {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
    return rel;
  };

  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-find-'));
    // Ruby: RSpec, named by convention, in a folder named after what it tests.
    write(root, 'spec/models/user_spec.rb', 'RSpec.describe User do' + NL + "  it 'works' do" + NL + '    expect(1).to eq(1)' + NL + '  end' + NL + 'end' + NL);
    // Ruby: a real spec under a directory the skip list calls build output.
    write(root, 'spec/lib/tooling/coverage/analyzer_spec.rb', 'RSpec.describe Analyzer do' + NL + "  it 'works' do" + NL + '    expect(1).to eq(1)' + NL + '  end' + NL + 'end' + NL);
    // PHP: named a test, in a folder the directory rule rejects.
    write(root, 'tests/integration/Support/Models/BillDateCalculatorTest.php',
          '<?php' + NL + 'class BillDateCalculatorTest extends TestCase' + NL + '{' + NL + '    public function testAdds(): void' + NL + '    {' + NL + '        $this->assertTrue(true);' + NL + '    }' + NL + '}' + NL);
    // PHP: a production class under a folder called Test. Laravel's test-notification feature.
    write(root, 'app/Notifications/Test/OwnerTestNotificationEmail.php',
          '<?php' + NL + 'class OwnerTestNotificationEmail extends Notification' + NL + '{' + NL + '    public function toMail($notifiable)' + NL + '    {' + NL + '        return new MailMessage();' + NL + '    }' + NL + '}' + NL);
    // Ruby: shared examples, which no naming convention claims. `RSpec.describe Foo do` has no
    // parenthesis, so the old content check could not have matched it even had it opened the file -
    // and it only ever opened .js, .ts and .py.
    write(root, 'spec/shared/user_behaviour.rb', 'RSpec.describe User do' + NL + "  it 'behaves' do" + NL + '    expect(1).to eq(1)' + NL + '  end' + NL + 'end' + NL);
    // PHP: a PHPUnit test whose name does not end in Test. The class is what makes it one.
    write(root, 'tests/unit/CalculatorChecks.php',
          '<?php' + NL + 'class CalculatorChecks extends TestCase' + NL + '{' + NL + '    public function testAdds(): void' + NL + '    {' + NL + '        $this->assertTrue(true);' + NL + '    }' + NL + '}' + NL);
    // Rust: an integration test whose tests come out of a macro, so the text says nothing.
    write(root, 'tests/regression.rs', 'use crate::util::Dir;' + NL + NL + 'rgtest!(r16, |dir: Dir| {' + NL + '    dir.create("a.txt", "xyz");' + NL + '});' + NL);
    return root;
  };

  const found = (root: string): Set<string> => new Set(testFiles(root).map((f) => f.slice(root.length + 1).split(String.fromCharCode(92)).join('/')));

  it('finds a Ruby spec, which it used to miss every one of', () => {
    assert.ok(found(project()).has('spec/models/user_spec.rb'), 'a _spec.rb is a test file');
  });

  it('does not let a folder name throw away a file whose own name says test', () => {
    // tests/integration/Support/... - `Support` is app/Support/, the thing being tested.
    assert.ok(found(project()).has('tests/integration/Support/Models/BillDateCalculatorTest.php'));
  });

  it('does not call a production class a test because it sits in a folder called Test', () => {
    const files = found(project());
    assert.ok(!files.has('app/Notifications/Test/OwnerTestNotificationEmail.php'), 'no TestCase, no attribute, not a test');
  });

  it('finds a test whose name says nothing, by reading it', () => {
    // The old check opened only .js, .ts and .py and looked for `describe(`, `it(` or `test(` with
    // a parenthesis - so Ruby's `RSpec.describe User do` could not match even in a file it read.
    const files = found(project());
    assert.ok(files.has('spec/shared/user_behaviour.rb'), 'RSpec shared examples are test code');
    assert.ok(files.has('tests/unit/CalculatorChecks.php'), 'a PHPUnit class is a test whatever it is called');
  });

  it('finds a Rust integration test whose tests come from a macro', () => {
    // Cargo compiles every .rs under tests/ as a test crate; 14 of ripgrep's 18 use `rgtest!`,
    // and chasing one project's macro name is not a rule.
    assert.ok(found(project()).has('tests/regression.rs'));
  });

  it('walks a folder the skip list calls build output when it is inside a test tree', () => {
    // discourse keeps eight specs for its coverage tooling under spec/lib/.../coverage/.
    assert.ok(found(project()).has('spec/lib/tooling/coverage/analyzer_spec.rb'));
  });

  it('says when it stopped before the end, rather than returning a sample as a total', () => {
    // n8n has 8,308 test files and this returned 4,003 of them, as a list with nothing to
    // distinguish it from a complete one.
    const root = project();
    const all = testFilesFound(root);
    assert.equal(all.stoppedEarly, false, 'a handful of files is not a bound');
    const bounded = testFilesFound(root, 2);
    assert.equal(bounded.stoppedEarly, true, 'and a walk that gave up has to say so');
    assert.ok(bounded.files.length <= 3, 'it stops at the bound it was given');
  });
});
