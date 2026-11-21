// What a slash means, measured per language, because it means four different things.
//
// `/` divides, opens a line comment, opens a block comment, or opens a regular expression, and
// which one it is depends on the language and on the token before it. Tewip's masking - the thing
// that decides which parts of a file are code and which are prose - got this wrong in three ways
// at once, and every one of them was silent:
//
//   JavaScript   a quote inside a regular expression opened a string that ran to the end of the
//                file. `engine/test/action-manifest.test.ts` in this repository holds six tests
//                and `vouch` read **none** of them, while reporting a clean 136 files. The file
//                guards the GitHub Action's manifest, written because nothing had ever run the
//                action; nothing had vouched for it either.
//   Python       `total // 2` is floor division, read as a line comment, so the rest of the line -
//                including the comparison in `assert total // 2 == 3` - was blanked. A blanked
//                comparison is how a real test is accused of checking nothing, which is the one
//                mistake this project cares about most.
//   Ruby         `//` is the empty pattern there, read as a comment too - and **not fixed**. Being
//                right about it cost 159 tests on discourse, so it is knowingly left wrong; the
//                footer says why, and `engine/vouch/slash.ts` carries the reasoning.
//
// The cause behind all of it: `textRanges` takes the language and six of its eight callers never
// passed it, although every one knew it. The same shape as Phase 200, where the masking existed
// and the gate in front of it never asked.
//
// Run: node eval/slash-reading.ts
import { testsIn, textRanges, type Language } from '../engine/vouch/tests-in.ts';
import { vouchFile } from '../engine/vouch/vouch.ts';

const NL = String.fromCharCode(10);

interface Case {
  what: string;
  language: Language;
  file: string;
  body: string;
  /** How many tests must be read. */
  tests: number;
  /** A fragment of the file that must NOT be masked, because it is code. */
  code?: string;
  /** A fragment that must be masked, because it is text. */
  text?: string;
  /** Every verdict must be one of these: a real test must never be accused. */
  allowed?: string[];
}

const CASES: Case[] = [
  {
    what: 'JavaScript: a quote inside a regular expression',
    language: 'js',
    file: 'a.test.ts',
    body: [
      // Each compares a value the code produced: `expect(2).toBe(2)` is a tautology, and Tewip
      // said so when this fixture was first written - correctly, about the fixture.
      "it('one', () => { expect(/[\"']/.test(s)).toBe(true); });",
      "it('two', () => { expect(cart.total).toBe(2); });",
      "it('three', () => { expect(cart.count).toBe(3); });",
    ].join(NL),
    tests: 3,
    code: "it('three'",
    allowed: ['checks'],
  },
  {
    what: 'JavaScript: a brace inside a regular expression, which closes no block',
    language: 'js',
    file: 'b.test.ts',
    body: ["it('counts', () => {", '  expect(/x{2,3}/.test(s)).toBe(true);', '  expect(total).toBe(3);', '});'].join(NL),
    tests: 1,
    allowed: ['checks'],
  },
  {
    what: 'JavaScript: division, which must stay code',
    language: 'js',
    file: 'c.test.ts',
    body: ["it('halves', () => {", '  const half = total / 2;', '  expect(half).toBe(3);', '});'].join(NL),
    tests: 1,
    code: 'expect(half).toBe(3)',
    allowed: ['checks'],
  },
  {
    what: 'JavaScript: a regular expression after a keyword, where an identifier also sits',
    language: 'js',
    file: 'd.test.ts',
    body: ["it('matches', () => {", '  const f = (s) => { return /^a"b/.test(s); };', '  expect(f(x)).toBe(true);', '});'].join(NL),
    tests: 1,
    code: 'expect(f(x)).toBe(true)',
    allowed: ['checks'],
  },
  {
    what: 'JavaScript: a slash inside a character class closes nothing',
    language: 'js',
    file: 'e.test.ts',
    body: ["it('splits', () => {", "  expect(/[a-z/]+\"/.test(s)).toBe(true);", '  expect(n).toBe(1);', '});'].join(NL),
    tests: 1,
    allowed: ['checks'],
  },
  {
    what: 'JavaScript: a line comment is still a comment',
    language: 'js',
    file: 'f.test.ts',
    body: ["it('ignores the comment', () => {", '  // expect(1).toBe(2) is not a check', '  expect(real).toBe(1);', '});'].join(NL),
    tests: 1,
    text: 'expect(1).toBe(2) is not a check',
    allowed: ['checks'],
  },
  {
    what: 'Python: floor division is not a comment',
    language: 'python',
    file: 'tests/test_pages.py',
    body: ['def test_halves():', '    assert total // 2 == 3'].join(NL),
    tests: 1,
    code: '== 3',
    allowed: ['checks'],
  },
  {
    what: 'JSX: two self-closing tags on one line, which is not a pattern between them',
    language: 'js',
    file: 'Row.test.tsx',
    body: ["it('renders both rows', () => {", '  render(<Row a="1" /><Row b="2" />);', '  expect(screen.getAllByRole("row")).toHaveLength(2);', '});'].join(NL),
    tests: 1,
    // The regression the corpus caught and this harness did not: `vouch` read 374 fewer tests on
    // one repository. JSX puts a `/` where a value is expected, and two on a line masked between.
    code: '<Row b="2"',
    allowed: ['checks'],
  },
  {
    what: 'JSX: a closing tag, where the slash follows the angle bracket',
    language: 'js',
    file: 'Panel.test.tsx',
    body: ["it('renders the panel', () => {", '  const ui = <div><span>x</span></div>;', '  expect(ui).toBeTruthy();', '});'].join(NL),
    tests: 1,
    code: '</span></div>',
    allowed: ['checks'],
  },
  {
    what: 'Python: floor division before the only check on the line',
    language: 'python',
    file: 'tests/test_half.py',
    body: ['def test_halves():', '    half = n // 2; assert half == 3'].join(NL),
    tests: 1,
    // The one that matters, and the reason this harness asks for verdicts and not only counts.
    // `withoutComments` removed everything from the slashes on, leaving `half = n`, and a test
    // that plainly compares was reported as one only a crash could fail.
    allowed: ['checks'],
  },
  {
    what: 'JavaScript: two divisions on one line, where a wrong reading masks the code between them',
    language: 'js',
    file: 'g.test.ts',
    body: ["it('averages', () => {", '  const rate = total / count / 2;', '  expect(rate).toBe(3);', '});'].join(NL),
    tests: 1,
    // Taking the second slash as the end of a regex started at the first masks ` count `. One
    // division on a line cannot show this: there is no closing slash, so the misreading is
    // harmless and the first version of this harness missed it.
    code: 'count / 2',
    allowed: ['checks'],
  },
  {
    what: 'JavaScript: a private class field, which is not a comment',
    language: 'js',
    file: 'h.test.ts',
    body: ['class Counter {', '  #count = 0;', '  bump() { this.#count += 1; return this.#count; }', '}', '', "it('bumps', () => { expect(new Counter().bump()).toBe(1); });"].join(NL),
    tests: 1,
    code: '#count = 0',
    allowed: ['checks'],
  },
  {
    what: 'Python: the positional-only marker in a signature is not a regular expression',
    language: 'python',
    file: 'tests/test_sig.py',
    body: ['def helper(a, b, /, c):', '    return a + b + c', '', 'def test_adds():', '    assert helper(1, 2, c=3) == 6'].join(NL),
    tests: 1,
    code: '== 6',
    allowed: ['checks'],
  },
  {
    // The shape from discourse's youtube_onebox_spec.rb, where `//` reaches a `%r{}` through an
    // `https://` URL. Tewip reads it as a comment, which is wrong about Ruby, and being right cost
    // **159 tests** across that suite - see the footer. **This case does not catch that**: the
    // sabotage leaves every number here at 16 of 16, because a short fixture has none of the quote
    // parity of a 3,000-line file. It keeps the ordinary shape honest, nothing more.
    what: 'Ruby: `//` inside a percent-literal, read as a comment - wrong, and load-bearing',
    language: 'ruby',
    file: 'spec/onebox_spec.rb',
    body: [
      'it "fetches the oEmbed" do',
      '  stub_request(:get, %r{//www\\.youtube\\.com/oembed\\?url=https://www\\.youtube\\.com/watch})',
      '  expect(Onebox.preview(url).to_s).to include("iframe")',
      'end',
      'it "falls back to the embed page" do',
      '  expect(Onebox.preview(other).to_s).to include("embed")',
      'end',
    ].join(NL),
    // Both, which is the number that matters: the second declaration must not be swallowed.
    tests: 2,
    allowed: ['checks'],
  },
  {
    what: 'Ruby: a pattern holding a quote, which Tewip deliberately does not read as a pattern',
    language: 'ruby',
    file: 'spec/line_spec.rb',
    body: ['it "finds the line" do', '  expect(line =~ /^a"b/).to eq 0', 'end'].join(NL),
    tests: 1,
    // Ruby is not in REGEX_LITERALS, so the quote here opens a string that should not be open -
    // and the test is still read and still not accused, which is the pre-existing behaviour kept
    // on purpose. Guessing at `/` with the file's quote parity at stake cost discourse 206 tests.
    allowed: ['checks'],
  },
  {
    what: 'Java: a slash divides, and there are no regular expression literals to confuse it with',
    language: 'jvm',
    file: 'src/test/java/shop/CartTest.java',
    body: ['class CartTest {', '  @Test', '  void halves() {', '    int half = total / 2;', '    assertEquals(3, half);', '  }', '}'].join(NL),
    tests: 1,
    code: 'assertEquals(3, half)',
    allowed: ['checks'],
  },
];

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

export interface Measured {
  what: string;
  /** Every property this case asserts held. */
  right: boolean;
  /** What went wrong, for the report. */
  wrong: string[];
}

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): Measured[] {
  return CASES.map((c): Measured => {
    const wrong: string[] = [];
    const found = testsIn(c.language, c.body);
    if (found.length !== c.tests) wrong.push(`${found.length} test(s) read, not ${c.tests}`);
    const ranges = textRanges(c.body, c.language);
    const masked = (fragment: string): boolean => {
      const at = c.body.indexOf(fragment);
      return at >= 0 && ranges.some(([from, to]) => at > from && at < to);
    };
    if (c.code !== undefined && masked(c.code)) wrong.push(`\`${c.code}\` is code and was masked as text`);
    if (c.text !== undefined && !masked(c.text)) wrong.push(`\`${c.text}\` is text and was read as code`);
    if (c.allowed) {
      const vouched = vouchFile(c.file, c.body);
      for (const j of vouched.judgements) {
        if (!c.allowed.includes(j.verdict)) wrong.push(`**${j.name}** was called ${j.verdict}`);
      }
    }
    return { what: c.what, right: wrong.length === 0, wrong };
  });
}

function report(): void {
  const all = measure();
  const right = all.filter((m) => m.right);
  const lines = [
    '# What a slash means, per language',
    '',
    `${CASES.length} files, each holding a slash that means something different.`,
    '',
    `Read correctly: ${right.length} of ${all.length} (${pct(right.length, all.length)})`,
    '',
  ];
  const broken = all.filter((m) => !m.right);
  if (broken.length === 0) lines.push('Every slash above is read as the language reads it, and no real test is accused.', '');
  else {
    lines.push('## Read wrongly', '');
    for (const m of broken) lines.push(`- **${m.what}**`, ...m.wrong.map((w) => `  - ${w}`));
    lines.push('');
  }
  lines.push(
    '---',
    '',
    'Every case asserts two things: that the tests are read, **and** that none is given a verdict',
    'it does not deserve. A masking error rarely hides a test - it blanks the comparison inside one,',
    'and that looks exactly like a test comparing nothing.',
    '',
    'Thirteen decisions were sabotaged one at a time. **Eight are earned**: taking one back drops a',
    'number above. **Five are not**, and are named rather than counted - a fix no measurement can',
    'miss is a fix nobody can trust:',
    '',
    "- the language `pythonTests` and `rubyTests` pass to `textRanges`, and gating `#` comments out",
    '  of JavaScript, Go, Java, C# and Rust. Correct, and narrow: no case here can tell, because',
    '  neither finder uses masking to take a body, and nobody writes code after a `#` attribute.',
    '- **the two Ruby decisions, which are the interesting ones**: `//` read as a comment although',
    '  it is the empty pattern, and `/` left inert although Ruby has pattern literals. Both wrong',
    '  about the language, both deliberate, both reasoned out in `engine/vouch/slash.ts`. Reading',
    '  Ruby properly cost 206 tests on discourse, 159 with half undone. Taking either back leaves',
    '  every number here at 16 of 16: **the guard is discourse in `corpus/expected.json`, not this',
    '  harness**, which is the honest shape of it.',
    '',
    'Not measured at all: `/` in code that is not a test. `candidateMutants` in engine/prove still',
    'cannot say what language it reads, so undefined means "JavaScript, probably" - an assumption.',
    '',
  );
  process.stdout.write(lines.join(NL));
  if (broken.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
