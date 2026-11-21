// Is this a test file? Measured both ways, because the gate in front of every test reader is the
// one check whose mistakes are invisible from its output.
//
// `looksLikeTests` decides whether Tewip reads a file as tests at all. Everything downstream is
// gated on it: `vouch` judges nothing it refuses, and `tewip start` - the front door, the first
// thing anybody runs - counts what it accepts and prints that count as "N test files here".
//
// Both directions cost something real, and they are not symmetrical:
//
//   A file refused that is a test  -> it vanishes. `vouch` says nothing about it and the count is
//                                    short. This is the Flutter defect of Phase 186: a verdict
//                                    over a corner of a repository, printed as a verdict over the
//                                    repository.
//   A file accepted that is not    -> `vouch` reads it, finds no test, and drops it, so the
//                                    verdict stays right. The front door's count does not: it had
//                                    no reader behind it to absorb the mistake, and in Phase 200
//                                    it announced **298 test files in this repository against a
//                                    real 133** - a tool built out of regular expressions calling
//                                    `.test(` in nearly every file it has.
//
// So the controls below are weighted the same, and every decoy is a file that was really being
// counted as a test: four from this repository, and five found by pointing the front door at an
// unrelated Python project.
//
// Run: node eval/test-file-recall.ts
import { looksLikeTests } from '../engine/vouch/is-a-test-file.ts';

const NL = String.fromCharCode(10);

interface Case {
  /** What this file is, said the way a person would say it. */
  what: string;
  file: string;
  body: string;
  /** For a decoy: what matched, and why counting it would be wrong. */
  why?: string;
}

/** Test files that must be recognised. The ones not named like tests are the point. */
const TESTS: Case[] = [
  {
    what: 'a Jest file named like a test',
    file: 'src/cart.test.ts',
    body: ["it('adds up', () => { expect(total([1, 2])).toBe(3); });"].join(NL),
  },
  {
    what: 'a Mocha suite in a file named nothing in particular',
    file: 'src/checkout-behaviour.ts',
    body: ["describe('checkout', () => {", "  it('charges once', () => { expect(charges).toBe(1); });", '});'].join(NL),
  },
  {
    what: 'pytest, by the filename convention',
    file: 'tests/test_cart.py',
    body: ['def test_adds_up():', '    assert total([1, 2]) == 3'].join(NL),
  },
  {
    what: 'pytest in a file the convention does not name',
    file: 'app/checks.py',
    body: ['def test_adds_up():', '    assert total([1, 2]) == 3'].join(NL),
  },
  {
    what: 'Go, which puts the convention in the filename',
    file: 'cart/cart_test.go',
    body: ['func TestAddsUp(t *testing.T) {', '\tif total() != 3 { t.Fatal("no") }', '}'].join(NL),
  },
  {
    what: 'JUnit, by its annotation rather than its name',
    file: 'src/main/java/shop/CartChecks.java',
    body: ['class CartChecks {', '  @Test', '  void addsUp() { assertEquals(3, total()); }', '}'].join(NL),
  },
  {
    what: 'xUnit, by its attribute',
    file: 'Shop/CartChecks.cs',
    body: ['public class CartChecks {', '  [Fact]', '  public void AddsUp() { Assert.Equal(3, Total()); }', '}'].join(NL),
  },
  {
    what: 'RSpec, which is a block and not a call',
    file: 'app/cart_behaviour.rb',
    body: ['RSpec.describe Cart do', "  it 'adds up' do", '    expect(total).to eq 3', '  end', 'end'].join(NL),
  },
  {
    what: 'Rust, by its attribute',
    file: 'src/cart.rs',
    body: ['#[test]', 'fn adds_up() { assert_eq!(total(), 3); }'].join(NL),
  },
  {
    what: 'PHPUnit, by the class it extends',
    file: 'app/CartChecks.php',
    body: ['class CartChecks extends TestCase {', '  public function testAddsUp() { $this->assertSame(3, total()); }', '}'].join(NL),
  },
];

/** Source files that must be refused. Every one of these was being counted as a test file. */
const SOURCE: Case[] = [
  {
    what: 'JavaScript applying a regular expression',
    file: 'app/static/home.js',
    body: ['function direction(character) {', '  if (/[\\u0600-\\u06ff]/.test(character)) return "rtl";', '  return "ltr";', '}'].join(NL),
    why: '`.test(` is how JavaScript asks whether a pattern matches. Til-AI has two such files and both were test files; this repository had dozens',
  },
  {
    what: 'the same thing through a named pattern',
    file: 'app/static/library.js',
    body: ['const RTL_PATTERN = /[\\u0600-\\u06ff]/;', 'function direction(text) {', '  return RTL_PATTERN.test(text) ? "rtl" : "ltr";', '}'].join(NL),
    why: 'the receiver is a variable rather than a literal, which no pattern over `test(` can tell from a declaration',
  },
  {
    what: 'a Python file with a variable named context',
    file: 'app/ai_service.py',
    body: ['def build_prompt(book, page):', '    context = {', '        "book": book,', '        "page": page,', '    }', '    return TEMPLATE.format(**context)'].join(NL),
    why: "**`context = {`** matched RSpec's `context` block, which is not Python syntax and was being asked of every language. Til-AI's 500-line prompt builder was a test file",
  },
  {
    what: 'a Playwright configuration under e2e/',
    file: 'e2e/playwright.config.ts',
    body: ['export default defineConfig({', "  testDir: './tests',", '  retries: 2,', '});'].join(NL),
    why: 'it sits under a directory the naming rule claims, and declares where the tests are rather than any test',
  },
  {
    what: 'the plural idiom in an output string',
    file: 'engine/attest/attest.ts',
    body: ['export function summarise(a: Attestation): string {', '  return `${a.testsAttempted} test(s) attempted, ${a.failures} failed.`;', '}'].join(NL),
    why: '`test(s)` matches `test\\s*\\(`. A tool that writes sentences about tests writes this constantly, and it is prose, not code',
  },
  {
    what: 'a comment mentioning what the selector no longer finds',
    file: 'engine/drift-rules.ts',
    body: ['// The selector no longer finds it (renamed), or now finds several.', 'export const DRIFT = 1;'].join(NL),
    why: '`it (` in English matches `it\\s*\\(`. The masking that would have caught this already existed for the extractor and was never asked by the gate',
  },
  {
    what: 'a docstring describing a test',
    file: 'app/runner.py',
    body: ['def run(suite):', '    """Call it (the suite) and collect what each test(s) run reports."""', '    return suite.go()'].join(NL),
    why: 'the same two idioms inside a Python docstring, which is text and not a declaration',
  },
  {
    what: 'a Python prompt template whose instructions read like an RSpec block',
    file: 'app/prompts.py',
    body: ['PROMPT = """', 'describe each page in order, do not skip any', 'context matters: quote the source line', '"""'].join(NL),
    why: "this is what earns the Ruby gate rather than the `do` rule: `describe each page in order, do ...` is an RSpec block as far as the pattern is concerned, and it is an English sentence in a Python string. Found by sabotage - without this case, removing the gate changed no number, and a fix no measurement can miss is a fix nobody can trust",
  },
  {
    what: 'a Ruby file with a variable named context',
    file: 'app/models/cart.rb',
    body: ['class Cart', '  def to_h', '    context = { items: @items }', '    context.merge(total: total)', '  end', 'end'].join(NL),
    why: 'gating RSpec on Ruby is not enough on its own - `context = {}` is as ordinary in Ruby as anywhere, so the `do` that makes it a block is required too',
  },
  {
    what: 'a PHP controller with an endpoint called testRule',
    file: 'app/Http/Controllers/RuleController.php',
    body: ['class RuleController extends Controller {', '  public function testRule(Request $r) { return $this->fire($r); }', '}'].join(NL),
    why: 'kept from an earlier phase: firefly-iii has eight of these, and a PHPUnit test is defined by the TestCase it extends',
  },
];

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

export interface Measured {
  what: string;
  /** What `looksLikeTests` said. */
  read: boolean;
  why?: string;
}

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { tests: Measured[]; source: Measured[] } {
  const judge = (c: Case): Measured => ({ what: c.what, read: looksLikeTests(c.file, c.body), why: c.why });
  return { tests: TESTS.map(judge), source: SOURCE.map(judge) };
}

function report(): void {
  const { tests, source } = measure();
  const found = tests.filter((t) => t.read);
  const missed = tests.filter((t) => !t.read);
  const wrong = source.filter((s) => s.read);
  const lines = [
    '# Is this a test file? Measured in both directions',
    '',
    `${TESTS.length} test files that must be read, ${SOURCE.length} source files that must not be.`,
    '',
    `Test files recognised:   ${found.length} of ${TESTS.length} (${pct(found.length, TESTS.length)})`,
    `Source files refused:    ${SOURCE.length - wrong.length} of ${SOURCE.length} (${pct(SOURCE.length - wrong.length, SOURCE.length)})`,
    '',
  ];
  if (missed.length > 0) {
    lines.push('## Test files it would not read', '', ...missed.map((t) => `- **${t.what}** — \`vouch\` says nothing about this file and the front door does not count it`), '');
  }
  if (wrong.length > 0) lines.push('## Source files it counts as tests', '', ...wrong.map((s) => `- **${s.what}** — ${s.why}`), '');
  if (missed.length === 0 && wrong.length === 0) {
    lines.push('Every test file here is read, and every source file is left alone.', '');
  }
  lines.push(
    '---',
    '',
    'Beside these planted cases, two things were measured on real trees, because a fixture cannot',
    'show either:',
    '',
    '- **The count, against ground truth.** This repository: 298 test files reported, 133 named like',
    '  one; now 148 against 136 that give up a test. An unrelated Python project: 37 reported, 33',
    '  real. A clone of the Flutter SDK: unchanged, and still says outright that it cannot read Dart.',
    '- **The expensive direction, which is losing a file.** Masking strings and comments makes this',
    "  gate stricter, so it could refuse a test file it used to take. Across those three trees it",
    '  refuses 748 files and **0 of them hold a test** the old rule would have read. Three trees, not',
    '  a proof.',
    '',
    'What is still not measured: how many shapes are missing from the list above - these are the',
    'frameworks that were in front of me - and the count the front door prints on the 14 repositories',
    'in `corpus/expected.json`, which pins eight commands and not this one. That absence is why the',
    'defect survived two earlier fixes, and closing it needs a verified run rather than a number',
    'typed in here.',
    '',
  );
  process.stdout.write(lines.join(NL));
  if (missed.length > 0 || wrong.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
