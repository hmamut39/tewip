// Reading Ruby's tests, which needed a file of its own once Ruby stopped being an afterthought.
//
// Split out of find-tests.ts in Phase 205, when that file passed 300 lines. Ruby earned the split
// over four phases in one day, every one of them found by running Tewip on discourse rather than
// by reading this code:
//
//   202  `%r{}` and heredocs are text, and a quote inside one broke the parity of the whole file
//   204  a helper that asserts is called without parentheses, so none of them were ever found
//   204  `expect do ... end.to` is the block form Ruby uses for anything over one line
//   205  a name read with `[^"')]*` stops at the apostrophe in a contraction
//
// `ruby-literals.ts` holds the masking side. This holds the reading side: where a test starts,
// what it is called, what belongs to it, and whether it runs.
import { isText, lineAt, textRanges, type FoundTest } from './tests-in.ts';

/**
 * Ruby, in both of the two shapes that cover nearly all of it: minitest's `def test_name ... end`
 * and RSpec's `it "name" do ... end`. Rails's own activesupport tests are the first; rspec-core's
 * own specs are the second.
 *
 * The body runs to the `end` that lines up with the opener's indentation. Counting `do`, `def`,
 * `if`, `case` and the rest against `end` would be the thorough way and is a poor trade: Ruby has
 * one-line `if` modifiers, `end` inside strings, and heredocs, so a counter gets it wrong on real
 * code in ways that are hard to see. Matching the indentation is right for conventionally
 * formatted Ruby, which is nearly all Ruby, and when it cannot find the closing `end` the test is
 * skipped rather than judged on a body that was guessed at.
 */
export function rubyTests(text: string): FoundTest[] {
  /** Each accepted test with the line its `end` sits on, so a nested one can be recognised. */
  const found: Array<FoundTest & { endsAt: number }> = [];
  const lines = text.split(String.fromCharCode(10));
  const ranges = textRanges(text, 'ruby');
  const offsets: number[] = [];
  let seen = 0;
  for (const line of lines) {
    offsets.push(seen);
    seen += line.length + 1;
  }

  for (let i = 0; i < lines.length; i += 1) {
    //  def test_foo            minitest
    //  it "does a thing" do    RSpec
    //  test "does a thing" do  Rails and minitest's spec syntax
    //  specify { ... }         is deliberately not here: a one-line specify has no body to read.
    const hit = /^(\s*)(?:(?:x|f)?(it|test|scenario|example)\s*[("']|def\s+(test_\w+))/.exec(lines[i]);
    if (!hit) continue;
    if (isText(ranges, offsets[i] + hit[1].length)) continue;
    const indent = hit[1].length;

    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '' ) continue;
      if (/^\s*end\b/.test(line) && line.length - line.trimStart().length === indent) {
        close = j;
        break;
      }
    }
    if (close === -1) continue;

    // An `it` inside another `it` is not a test. rspec-core's own specs define one as a fixture -
    // `describe_successfully do it "..." do sequence << :example end end` - and the assertion that
    // matters is in the enclosing test. Python's finder skips nested defs for the same reason.
    if (found.some((earlier) => i > earlier.line - 1 && i < earlier.endsAt)) continue;

    const body = lines.slice(i + 1, close).join(String.fromCharCode(10));
    // Read to the quote that opened the name, not to the first quote of any kind.
    //
    // `[^"')]*` stopped at the apostrophe in an English contraction, so discourse's
    //
    //     it "doesn't process email with same message-id more than once" do
    //
    // was reported as a test called **"doesn"**. The name is the whole of what a person reads in
    // the report, and in the ticket `tewip bugs` files from it, so a truncated one is a finding
    // nobody can match to a test. Found in Phase 205 while reading the accusations in Phase 204 -
    // every name in that list broke at an apostrophe and I had read past it twice.
    const named =
      hit[3] ?? /^\s*(?:x|f)?(?:it|test|scenario|example)\s*\(?\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/.exec(lines[i])?.[2]?.trim();
    found.push({
      endsAt: close,
      name: (named ?? '').trim() === '' ? 'unnamed' : (named as string),
      line: i + 1,
      body,
      // `xit` turns a test off. A bare `skip` does too - but only at the top level of the body.
      // rspec-core's own specs pass a block containing `skip "because"` to a helper, as the
      // fixture whose behaviour the test is checking, and the test around it asserts plenty.
      // Reading that as "this test never runs" condemned the reference implementation.
      skipped: /^\s*(?:x(?:it|specify|example)|skip\b)/.test(lines[i]) || skipsAtTopLevel(body),
      callback: '',
    });
  }
  return found;
}



/**
 * A Ruby `skip` that turns this test off, rather than one sitting inside a block the test is
 * handing to something else. Only a call at the body's own indentation counts: anything deeper is
 * inside a block, and in rspec-core's specs that block is the fixture under test.
 */
function skipsAtTopLevel(body: string): boolean {
  const lines = body.split(String.fromCharCode(10)).filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;
  const base = Math.min(...lines.map((l) => l.length - l.trimStart().length));
  // Not a `skip` carrying a trailing condition. Ruby writes a guard as a modifier -
  //
  //     skip "suggested topic not found in results" if suggested_topic.nil?
  //
  // - and that test runs every time the condition is false, which is most of the time. The Go side
  // has refused conditional skips since it was written; Ruby's was added in Phase 36 without it, and
  // discourse has four tests that run perfectly well being called "never runs".
  return lines.some(
    (l) =>
      l.length - l.trimStart().length === base &&
      /^\s*(?:skip|pending)\b/.test(l) &&
      !/\s(?:if|unless)\s/.test(l),
  );
}
