// Ruby's other ways of writing a string, which is the reason Tewip reads Ruby's `//` wrongly on
// purpose.
//
// `textRanges` in tests-in.ts masks strings and comments so that the readers above it can tell code
// from prose. It understood `'`, `"` and `` ` `` and nothing else, and Ruby has two more families:
//
//     %r{(http:|["']//)}        a percent literal - here a pattern holding both quote characters
//     <<~SQL ... SQL            a heredoc, whose body is text and is full of anything
//
// discourse writes the first on line 134 of `spec/lib/onebox/engine/youtube_onebox_spec.rb`. With
// no idea it is inside a literal, the scanner read that `'` as opening a string, the next `'` was
// lines away, and the quote parity of the rest of the file was wrong: twenty declarations ended up
// inside a phantom string and were skipped as prose. The file read **22 tests as 2**, and across
// discourse's spec suite that was 159 tests.
//
// Reading `//` as a comment - which Ruby does not - truncates each such line at the slashes, and
// so cuts the literal off before its quotes can do harm. That accident is what Phase 201b had to
// put back, and `C_COMMENTS` in slash.ts carries the apology. This file is the thing that has to
// work before that line can be made true.
//
// What a percent literal is: `%`, an optional type letter, a delimiter, a body, the closing
// delimiter. `( )`, `[ ]`, `{ }` and `< >` are paired and **nest**; any other punctuation is its
// own closer. A backslash escapes the next character in both.
//
// Nothing is imported from tests-in.ts: it imports this, and a cycle between the masker and the
// thing it asks is how the `find-tests.ts` pair already reads, which is enough of that.

/** The type letters Ruby allows. `%` alone is `%Q`, and is deliberately not read - see below. */
const TYPES = 'qQwWiIrsx';

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/**
 * Where the percent literal starting at `at` ends, or -1 if this `%` is not one.
 *
 * Only the typed forms - `%r{`, `%w[`, `%q(`, `%i[` and so on - because `%` is also modulo and
 * `"%s" % name` is how Ruby formats a string. The type letter makes it unambiguous; a bare `%(`
 * does not, and reading it would be the same guess that cost 206 tests when `/` was guessed at.
 * Every percent literal in discourse's spec suite is typed.
 */
export function rubyPercentLiteral(text: string, at: number): number {
  if (text[at] !== '%') return -1;
  const type = text[at + 1] ?? '';
  if (!TYPES.includes(type)) return -1;
  const open = text[at + 2] ?? '';
  // A delimiter is punctuation. `%w` followed by a letter is not a literal - it is `%` applied to
  // something named `w...`, which is not valid Ruby either, but refusing is the safe answer.
  if (open === '' || /[\w\s]/.test(open)) return -1;
  const close = PAIRS[open] ?? open;
  const nests = close !== open;
  let depth = 1;
  for (let i = at + 3; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === String.fromCharCode(92)) {
      i += 1;
      continue;
    }
    if (nests && ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  // Unterminated. Saying -1 rather than "to the end of the file" is the lesson from `withoutComments`,
  // where an unclosed `/*` was taken to the end of the body and deleted three real assertions.
  return -1;
}

/** A heredoc marker: `<<~SQL`, `<<-EOS`, `<<EOF`, and the quoted forms `<<~'SQL'` and `<<"EOF"`. */
const HEREDOC = /<<([~-]?)(['"]?)([A-Z_][A-Z_0-9]*)\2/;

/**
 * The heredoc body opened by a marker on the line containing `at`, as [from, to], or null.
 *
 * The body is not where the marker is: it starts after that line's newline and runs to a line whose
 * only content is the identifier. So this is asked once per line rather than per character, and it
 * reports the range for the scanner to jump to.
 *
 * One heredoc per line. Ruby allows several - `foo(<<~A, <<~B)` - and their bodies follow in order;
 * that is rare enough in a test suite to be worth refusing rather than half-reading, and refusing
 * means the scanner carries on as it did before, which is the behaviour this replaces.
 */
export function rubyHeredoc(text: string, lineStart: number, lineEnd: number): [number, number] | null {
  const line = text.slice(lineStart, lineEnd);
  const hit = HEREDOC.exec(line);
  if (!hit) return null;
  // Two markers on one line: refuse, rather than read the first body as both.
  if (HEREDOC.exec(line.slice((hit.index ?? 0) + hit[0].length))) return null;
  const id = hit[3];
  const from = lineEnd;
  const lines = text.slice(from + 1).split(String.fromCharCode(10));
  let at = from + 1;
  for (const body of lines) {
    if (body.trim() === id) return [from, at + body.length];
    at += body.length + 1;
  }
  return null;
}

/** Every line's [start, end-before-the-newline], so the heredoc reader can be asked per line. */
export function lineSpans(text: string): Array<[number, number]> {
  const NL = String.fromCharCode(10);
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (;;) {
    const nl = text.indexOf(NL, at);
    const end = nl === -1 ? text.length : nl;
    spans.push([at, end]);
    if (nl === -1) return spans;
    at = nl + 1;
  }
}
