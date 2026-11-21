// Ruby's other ways of writing text, and whether a quote inside one still destroys a file.
//
// `textRanges` masks strings and comments so the readers above it can tell code from prose. It knew
// `'`, `"` and `` ` ``. Ruby has two more families, and both are full of quotes:
//
//     %r{(http:|["']//)}            a percent literal - a pattern holding both quote characters
//     <<~HTML ... Sun Tzu's ... HTML a heredoc whose body is HTML with an apostrophe in it
//
// Both shapes are from discourse. Each one opened a string that was never closed where the scanner
// thought, the quote parity of everything after it was wrong, and declarations further down the
// file sat inside a phantom string and were skipped as prose:
//
//   `spec/lib/onebox/engine/youtube_onebox_spec.rb`   22 tests read as 2
//   `spec/system/localized_internal_oneboxes_spec.rb`  2 tests read as 0, hidden by an apostrophe
//                                                      in "Sun Tzu's strategies"
//
// The measured effect of reading both: **28,156 -> 28,358 tests** across discourse's 2,443 spec
// files, 4 fewer crash-only accusations, and **0 files losing a single test**.
//
// What this does not buy yet: Ruby's `//` is still read as a comment, which is wrong, and
// `C_COMMENTS` in slash.ts still says so. Correcting it now costs 8 tests rather than the 159 it
// cost before this file existed, and 8 is still 8.
//
// Run: node eval/ruby-literal-recall.ts
import { testsIn } from '../engine/vouch/tests-in.ts';
import { vouchFile } from '../engine/vouch/vouch.ts';

const NL = String.fromCharCode(10);
/** A single backslash, written this way because a heredoc eats `\\` and leaves the file looking right. */
const BS = String.fromCharCode(92);

interface Case {
  what: string;
  body: string[];
  /** How many tests must be read. */
  tests: number;
  /** Every verdict must be one of these: a real test must never be accused. */
  allowed?: string[];
}

/** Two plain tests after the literal under test. If the literal breaks parity, they vanish. */
const AFTER = ['it "adds up" do', '  expect(cart.total).to eq 3', 'end', 'it "counts" do', '  expect(cart.size).to eq 1', 'end'];

const CASES: Case[] = [
  {
    what: 'a percent-literal pattern holding both quote characters (discourse, youtube_onebox_spec)',
    body: ['it "rewrites URLs" do', '  regex = %r{(http:|["\']//)}', '  expect(preview).not_to match(regex)', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'a heredoc whose body is HTML with an apostrophe (discourse, localized_internal_oneboxes_spec)',
    body: [
      'before do',
      '  post.update!(cooked: <<~HTML)',
      '    <div class="title">',
      "      <a href='/t/1'>Sun Tzu's strategies</a>",
      '    </div>',
      '  HTML',
      'end',
      ...AFTER,
    ],
    tests: 2,
    allowed: ['checks'],
  },
  {
    what: 'a quoted heredoc identifier, which takes no interpolation',
    body: ['before do', "  run(<<~'SQL')", '    SELECT \'a\' FROM t', '  SQL', 'end', ...AFTER],
    tests: 2,
    allowed: ['checks'],
  },
  {
    what: 'the dash form of a heredoc, where the terminator may be indented',
    body: ['before do', '  run(<<-EOS)', "    it's fine", '  EOS', 'end', ...AFTER],
    tests: 2,
    allowed: ['checks'],
  },
  {
    what: 'a word array with an apostrophe in it',
    body: ['it "lists them" do', "  names = %w[o'brien smith]", '  expect(names.size).to eq 2', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'a single-quoted percent literal containing an apostrophe',
    body: ['it "quotes" do', "  msg = %q(it's fine)", '  expect(msg).to include("fine")', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'a paired delimiter that nests, which a naive closer would end early',
    body: ['it "repeats" do', '  expect(s).to match(%r{a{2,3}"b})', '  expect(n).to eq 1', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'a delimiter that is not a pair, closed by itself',
    body: ['it "matches" do', '  expect(s).to match(%r!["\']!)', '  expect(n).to eq 1', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'an escaped delimiter inside the literal',
    body: ['it "escapes" do', `  expect(s).to match(%r{a${BS}}"b})`, '  expect(n).to eq 1', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'a symbol array',
    body: ['it "symbols" do', "  keys = %i[a b]", '  expect(keys.size).to eq 2', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  // The refusals. `%` is modulo, and reading it as a literal is the mistake that cost 206 tests
  // when `/` was guessed at. These must behave exactly as they did before this file existed.
  {
    what: 'string formatting, which is modulo and not a literal',
    body: ['it "formats" do', '  msg = "%s and %s" % [a, b]', '  expect(msg).to include("and")', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'arithmetic modulo',
    body: ['it "wraps" do', '  expect(total % 3).to eq 1', 'end', ...AFTER],
    tests: 3,
    allowed: ['checks'],
  },
  {
    what: 'an unterminated percent literal, which must not swallow the rest of the file',
    body: ['it "broken" do', '  expect(s).to match(%r{unclosed', '  expect(n).to eq 1', 'end', ...AFTER],
    // The declaration above is inside no literal, so it is still read; what matters is that the
    // two below it survive. Refusing an unterminated literal is the lesson from `withoutComments`,
    // where an unclosed `/*` ran to the end of the body and deleted three real assertions.
    tests: 3,
    allowed: ['checks', 'crash-only', 'cannot-tell'],
  },
];

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

export interface Measured {
  what: string;
  right: boolean;
  wrong: string[];
}

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): Measured[] {
  return CASES.map((c): Measured => {
    const text = c.body.join(NL);
    const wrong: string[] = [];
    const found = testsIn('ruby', text);
    if (found.length !== c.tests) wrong.push(`${found.length} test(s) read, not ${c.tests}`);
    if (c.allowed) {
      for (const j of vouchFile('spec/a_spec.rb', text).judgements) {
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
    "# Ruby's percent literals and heredocs, measured",
    '',
    `${CASES.length} files, each holding one of Ruby's text forms with a quote inside it, and two`,
    'plain tests underneath that disappear if the quote parity breaks.',
    '',
    `Read correctly: ${right.length} of ${all.length} (${pct(right.length, all.length)})`,
    '',
  ];
  const broken = all.filter((m) => !m.right);
  if (broken.length === 0) lines.push('Every form is read as text, every test underneath survives, and no test is accused.', '');
  else {
    lines.push('## Read wrongly', '');
    for (const m of broken) lines.push(`- **${m.what}**`, ...m.wrong.map((w) => `  - ${w}`));
    lines.push('');
  }
  lines.push(
    '---',
    '',
    'Measured on real Ruby as well, because this kind of defect needs a long file to show itself:',
    'across discourse’s 2,443 spec files, **28,156 -> 28,358 tests read**, 4 fewer crash-only',
    'accusations, and **0 files losing a test**. Two gains were read by hand against their source -',
    'a file that went 0 -> 2, hidden by the apostrophe in "Sun Tzu’s strategies" inside a heredoc',
    'of HTML, and one that went 22 -> 22 where it had read 2 with Ruby’s `//` corrected.',
    '',
    'Eight decisions were sabotaged one at a time. **Five are earned**: taking one back drops a',
    'number above - the percent branch costs 6 of 13, the heredoc branch 2, and nesting, the',
    'backslash escape and refusing an unterminated literal one each. **Three are not**, and they are',
    'named rather than counted:',
    '',
    '- requiring the type letter, so a bare `%(...)` is read as modulo rather than a string.',
    '- refusing a `%q` whose delimiter is a letter or a space.',
    '- refusing a line that opens two heredocs, whose bodies follow in order.',
    '',
    'All three are conservatism, and the honest thing to say is that no case here punishes removing',
    'them: a bare `%(...)` read as a literal masks a few characters of code and no declaration, so',
    'nothing visible changes. They are kept because reading them would be the same guess that cost',
    '206 tests when `/` was guessed at in Ruby, and the direction of that guess is unbounded while',
    'the cost of refusing is the behaviour of every release before this one. The two-heredoc line is',
    'a real gap, not only a refusal: a quote in the second body still breaks the file, and there is',
    'no case here for it because the case would fail.',
    '',
    'Still not bought: Ruby’s `//` is read as a comment, which is wrong. It now costs 8 tests on',
    'discourse instead of 159, and 8 is still 8 - so `C_COMMENTS` in slash.ts keeps its apology.',
    '',
  );
  process.stdout.write(lines.join(NL));
  if (broken.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
