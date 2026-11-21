// What a slash means, which is four different things depending on the language and the token
// before it: divide, open a line comment, open a block comment, or open a regular expression.
//
// Split out of tests-in.ts in Phase 201, when that file passed 300 lines again. It is one subject
// and it was wrong in three ways at once, every one of them silent:
//
//   JavaScript  a quote inside a regular expression opened a string that ran to the end of the
//               file. `engine/test/action-manifest.test.ts` in this repository holds six tests and
//               `vouch` read **none** of them while reporting a clean 136 files.
//   Python      `total // 2` is floor division, read as a line comment, so the rest of the line
//               was blanked - and `half = n // 2; assert half == 3` became `half = n`, which
//               compares no value. A test that plainly compares, reported as one only a crash
//               could fail.
//   Ruby        `//` is the empty regular expression, read as a comment, swallowing its line.
//
// The cause behind all three is the same and is not about slashes: `textRanges`, `braced` and
// `withoutComments` each take or want a language, and their callers did not pass one although
// every caller knew it. `withoutComments` was written to be handed every language and guess, and
// the header in text.ts already recorded two bugs that came of guessing. This was the third.
//
// Measured in eval/slash-reading.ts, per language, asserting both that the tests are read and that
// no test is accused - because a masking error does not usually hide a test, it blanks the
// comparison inside one.
import type { Language } from './tests-in.ts';

/**
 * Languages where `//` is treated as beginning a comment. **Ruby is in this list and should not
 * be**, and the honest name for that is a known wrong rule that is load-bearing.
 *
 * Python came out, which is the whole fix: `total // 2` is floor division, and reading it as a
 * comment removed the rest of the line. Ruby came out too, for the same reason - `//` is the empty
 * pattern there - and it had to go back, because the accident it caused was holding something up.
 *
 * discourse's `youtube_onebox_spec.rb` contains
 *
 *     stub_request(:get, %r{//www\.youtube\.com/oembed\?url=https://www\.youtube\.com/watch})
 *
 * and the `//` inside that percent-literal opened a comment that ran to the end of the line. That
 * accidental comment hid the `it` on that line - and `rubyTests` skips a declaration nested inside
 * an accepted one, so hiding the first one was what kept the next twenty visible. Reading Ruby
 * correctly made the first `it` real, its closing `end` was found far too late, and the file fell
 * from **22 tests to 2**. Across discourse's spec suite, being right about `//` cost 159 tests.
 *
 * So the fragility is in how `rubyTests` finds the `end` that closes a block, and this wrong rule
 * is compensating for it. Fixing them in the other order loses real tests on a real repository,
 * which is not a trade worth making for a rule nothing measurable depends on. The `end` matcher is
 * the phase that has to come first, and then this line changes.
 */
export const C_COMMENTS = new Set<Language>(['js', 'jvm', 'go', 'csharp', 'php', 'rust', 'ruby']);
/** Languages where `#` begins a comment. Not JavaScript, where `#count = 0` is a class field. */
export const HASH_COMMENTS = new Set<Language>(['python', 'ruby', 'php']);
/**
 * Languages where `/` can open a regular expression literal **and Tewip can tell**.
 *
 * Ruby belongs here by the language and is deliberately absent, which cost a phase to learn. Ruby
 * writes a pattern four ways, and `%r{...}` is the common one in real code:
 *
 *     expect(url).to match(%r{/tag/test/#{tag.id}/l/top\.json})
 *
 * The `/` after `%r{` sits where a value is expected, so it opened a pattern, `/tag/` was masked,
 * and from there the quote parity for the rest of the file was wrong. On discourse's spec suite
 * that was **206 tests lost in one subtree**, and `spec/requests/tags_controller_spec.rb` fell from
 * 209 tests to 52. Ruby also has `%w[]`, `%q()`, `%i[]` and heredocs, none of which this masker
 * knows, so reading `/` as a pattern there is guessing with the file's whole parity at stake.
 *
 * Doing it properly is a Ruby lexer. Until then Ruby keeps the behaviour of every release before
 * this one - `/` is inert - which loses nothing that was ever working. What Ruby does get from
 * this phase is `//` no longer being read as a comment, which is in `C_COMMENTS` and separate.
 */
export const REGEX_LITERALS = new Set<Language>(['js']);

/**
 * The words a `/` may follow and still open a regular expression.
 *
 * `return /^a/.test(x)` is a regex; `total / count` is division. Both have an identifier before
 * the slash, and nothing but the identifier itself tells them apart.
 */
const BEFORE_A_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw',
  // Ruby, which writes conditions without parentheses: `next if line =~ /x/`.
  'and', 'or', 'not', 'if', 'unless', 'when', 'while', 'until', 'then', 'begin', 'rescue', 'puts', 'match',
]);

/**
 * Does the `/` at `at` open a regular expression, or divide what came before it?
 *
 * Decided from the previous token, because that is the only thing that can decide it - this is the
 * one piece of real lexing in the file, and it is here because the alternative is worse. A value
 * ends before a division: an identifier, a number, a closing paren or bracket. Anything else -
 * `=`, `(`, `,`, `[`, `:`, an arrow, the start of the file, or a `}` that closed a block - is a
 * place where a value is expected, so a `/` there opens one.
 */
export function opensRegex(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return true;
  // JSX, which puts a `/` exactly where a value is expected, in two shapes: `</div>` has it after
  // the angle bracket, and `<Foo />` has it before one. Two on a line - ordinary in a React test -
  // and everything between them was masked as a pattern:
  //
  //     render(<Row a="1" /><Row b="2" />);    masked `/><Row b="2" /`
  //     const ui = <div><span>x</span></div>;  masked `/span></`
  //
  // which swallows declarations and, through `braced`, miscounts the braces that end a test body.
  // Found by the corpus, which is the only thing that did find it: on one repository `vouch` read
  // **374 fewer tests** and on another it lost two files outright. The bound measured in Phase 200
  // - 748 files refused and not one of them a real test - was taken on three trees with almost no
  // JSX in them and did not generalise. That is what the 14 repositories are for.
  //
  // Asked about this slash rather than about the span between it and the next one. Rejecting any
  // span containing an angle bracket was the first attempt, and it refused
  // `/^(\s*)([a-z-]+):[ \t]+(?!['"|>&*#])(.*)$/` - the regex in the very file this phase set out to
  // recover, which contains a `>` inside a lookahead. It read as a fix and undid the fix.
  if (text[i] === '<' || text[at + 1] === '>') return false;
  if (!/[\w$)\]]/.test(text[i])) return true;
  const word = /[\w$]+$/.exec(text.slice(0, i + 1))?.[0] ?? '';
  return BEFORE_A_REGEX.has(word);
}

/**
 * Where the regular expression opening at `from` ends, or -1 if this `/` was not one after all.
 *
 * A `/` inside a character class closes nothing - `/[a-z/]+/` is one expression - and a literal
 * never spans a line, so a slash with no partner before the newline was division.
 *
 */
export function closingSlash(text: string, from: number): number {
  let inClass = false;
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === String.fromCharCode(92)) {
      i += 1;
      continue;
    }
    if (ch === String.fromCharCode(10)) return -1;
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '/') return i;
  }
  return -1;
}
