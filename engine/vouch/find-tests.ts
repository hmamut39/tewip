// Phase 22 and after: finding the tests inside a file, in each language's own shape.
//
// Split out of tests-in.ts, which passed this project's 300-line rule when Ruby, PHP and Rust were
// added. tests-in.ts keeps the questions every language shares - which language is this, does it
// look like tests at all, which parts of it are text rather than code - and this file holds the
// four readers: callbacks (JavaScript), indentation (Python), `end` (Ruby), and braces (the rest).
import { braced, isText, lineAt, textRanges, type FoundTest, type Language } from './tests-in.ts';

/**
 * `it('...', async () => { ... })` and its many spellings, including `test.each`, `it.skip` and a
 * plain `function ()` callback. The body is taken by matching braces from the callback's opening one.
 */
function jsTests(text: string): FoundTest[] {
  const found: FoundTest[] = [];
  const ranges = textRanges(text);
  const declaration = /\b(it|test|specify)\s*(\.\s*(skip|only|todo|failing|concurrent|each|for)\s*(\([^)]*\)|`[^`]*`)?\s*)*\(\s*(['"`])((?:\\.|(?!\5)[^\\])*)\5/g;
  for (const hit of text.matchAll(declaration)) {
    const at = hit.index ?? 0;
    if (isText(ranges, at)) continue;
    const open = text.indexOf('{', at + hit[0].length);
    if (open === -1) continue;
    const body = braced(text, open);
    if (body === null) continue;
    const signature = text.slice(at + hit[0].length, open);
    found.push({
      name: hit[6],
      line: lineAt(text, at),
      body,
      skipped: /\.\s*(skip|todo|failing)\b/.test(hit[0]) || /\bxit\s*\(/.test(hit[0]),
      callback: /\(\s*([A-Za-z_$][\w$]*)\s*\)\s*(=>)?\s*$/.exec(signature.trim())?.[1] ?? '',
    });
  }
  // `xit(...)` and `xtest(...)`, which the pattern above deliberately does not match.
  for (const hit of text.matchAll(/\bx(it|test)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g)) {
    const at = hit.index ?? 0;
    if (isText(ranges, at)) continue;
    const open = text.indexOf('{', at + hit[0].length);
    const body = open === -1 ? null : braced(text, open);
    found.push({ name: hit[3], line: lineAt(text, at), body: body ?? '', skipped: true, callback: '' });
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Python has no braces: a test's body is everything indented further than its `def`. */
function pythonTests(text: string): FoundTest[] {
  const lines = text.split(String.fromCharCode(10));
  const ranges = textRanges(text);
  const offsets: number[] = [];
  let seen = 0;
  for (const line of lines) {
    offsets.push(seen);
    seen += line.length + 1;
  }
  const found: FoundTest[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const hit = /^(\s*)(?:async\s+)?def\s+(test_\w+|test)\s*\(/.exec(lines[i]);
    if (!hit) continue;
    if (isText(ranges, offsets[i] + hit[1].length + 1)) continue;
    const indent = hit[1].length;
    // Nested in another def? Then it is a helper or, in Click's tests, a CLI command that happens to
    // be named `test`. Only a module-level def, or a method of a test class, is a test.
    if (nestedInFunction(lines, i, indent)) continue;
    if (hit[2] === 'test' && indent > 0) continue;
    // A def whose parameters run over several lines ends at the line that closes them, and the body
    // starts after that. Without this, the parameter list was read as the body and the real body was
    // thrown away: psf/requests has several, and each came back as a test that compares no value.
    let signatureEnds = i;
    let open = 0;
    for (let j = i; j < lines.length && j < i + 20; j += 1) {
      open += (lines[j].match(/\(/g) ?? []).length - (lines[j].match(/\)/g) ?? []).length;
      signatureEnds = j;
      if (open <= 0) break;
    }

    const body: string[] = [];
    for (let j = signatureEnds + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      const width = line.length - line.trimStart().length;
      if (width <= indent) break;
      body.push(line);
    }
    // Decorators sit above the def, so skipping is read upwards.
    const above = lines.slice(Math.max(0, i - 4), i).join(String.fromCharCode(10));
    // A conditional skip runs somewhere - `skipif` on Windows registry tests in psf/requests runs
    // on Windows - so only an unconditional skip means the test never runs. `xfail` runs too.
    const skipped = /@\s*(pytest\s*\.\s*mark\s*\.\s*skip|unittest\s*\.\s*skip)\b/.test(above) && !/skipif|skipUnless|xfail/.test(above);
    found.push({ name: hit[2], line: i + 1, body: body.join(String.fromCharCode(10)), skipped, callback: '' });
  }
  return found;
}

/** Is the def on line `i` nested inside another def, rather than inside a class or at the top? */
function nestedInFunction(lines: string[], i: number, indent: number): boolean {
  for (let j = i - 1; j >= 0; j -= 1) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const width = line.length - line.trimStart().length;
    if (width >= indent) continue;
    return /^\s*(async\s+)?def\s/.test(line);
  }
  return false;
}

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
function rubyTests(text: string): FoundTest[] {
  /** Each accepted test with the line its `end` sits on, so a nested one can be recognised. */
  const found: Array<FoundTest & { endsAt: number }> = [];
  const lines = text.split(String.fromCharCode(10));
  const ranges = textRanges(text);
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
    const named = hit[3] ?? /^\s*(?:x|f)?(?:it|test|scenario|example)\s*[("']\s*["']?([^"')]*)/.exec(lines[i])?.[1]?.trim();
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
 * How each language says "this is a test".
 *
 * Rust and PHP join the braced finder rather than getting one of their own, because both mark a
 * test the way the JVM languages do: an attribute or a naming convention, then a braced body. Only
 * the marker differs.
 */
const DECLARES: Partial<Record<Language, RegExp>> = {
  // Rust marks a test with an attribute. `#[bench]` is left out for the same reason Go's Benchmark
  // is: it measures rather than checks, and calling it assertion-free is true and useless.
  rust: /#\s*\[\s*(?:test|tokio::test|async_std::test|rstest)\s*\]/g,
  // PHPUnit accepts three markers and real suites use all of them: the testFoo naming convention
  // (laravel/framework does this), the #[Test] attribute of PHPUnit 10, and the @test docblock.
  // `private`/`protected` dropped: PHPUnit collects public methods only, and a private helper whose
  // name happens to start with "test" is not one. See tests-in.ts for the production file this cost.
  php: /(?:#\s*\[\s*Test[^\]]*\]|\*\s*@test\b|(?:^|[^\w$>])(?:public\s+)?(?:static\s+)?function\s+test\w*\s*\()/gm,
};

/** JUnit, Kotlin, Scala, Go, C#, PHP and Rust: an annotation or a naming convention, then a braced body. */
function bracedTests(language: Language, text: string): FoundTest[] {
  const found: FoundTest[] = [];
  const ranges = textRanges(text, language);
  const declaration =
    DECLARES[language] ??
    (language === 'go'
      ? // Only a Test function. A Benchmark asserts nothing by design, an Example is checked against
        // its own Output comment, and a Fuzz target is not a test - all three were condemned as
        // "checks nothing" in gorilla/mux before this narrowed.
        /\bfunc\s+(Test)(\w+)\s*\(\s*\w+\s+\*testing\.[TB]\s*\)\s*\{/g
      : /(@Test\b[^\n]*|\[\s*(?:Test|Fact|Theory)[^\]]*\]|@(?:ParameterizedTest|RepeatedTest)\b)/g);
  for (const hit of text.matchAll(declaration)) {
    const at = hit.index ?? 0;
    if (isText(ranges, at)) continue;
    // Where the body starts. Go's marker already includes the brace. Rust and PHP put a signature
    // after the marker, and in PHP the marker may itself *be* the signature, so searching from the
    // end of the match covers both.
    const open =
      language === 'go'
        ? text.indexOf('{', at)
        : language === 'rust' || language === 'php'
          ? text.indexOf('{', at + hit[0].length)
          : text.indexOf('{', text.indexOf('(', at + hit[0].length));
    if (open === -1) continue;
    const body = braced(text, open);
    if (body === null) continue;
    const signature = text.slice(at, open);
    // `void foo() throws IOException` still names foo. Without allowing the throws clause, every
    // checked-exception test in gson was reported as 'unnamed'.
    const name =
      language === 'go'
        ? hit[1] + hit[2]
        : language === 'rust'
          ? // ripgrep generates whole families of tests from a macro, where the name in the source
            // is literally `$name`. Reporting that is more honest than inventing one.
            /\bfn\s+(\$?\w+)/.exec(text.slice(at, open))?.[1] ?? 'unnamed'
          : language === 'php'
            ? /\bfunction\s+(\w+)/.exec(text.slice(at, open))?.[1] ?? 'unnamed'
            : (/([\w]+)\s*\([^)]*\)\s*(throws\s+[\w.,\s]+)?$/.exec(signature.trim())?.[1] ?? 'unnamed');
    const around = text.slice(Math.max(0, at - 200), open);
    // An annotation disables a test outright. A `t.Skip()` may be conditional - cobra's
    // TestDeadcodeElimination skips on Windows and runs everywhere else - so it counts only when it
    // is unconditional, at the top level of the body.
    // xUnit - the most used .NET framework by a distance - has no separate attribute for this. It
    // skips by giving the test attribute a reason: `[Fact(Skip = "...")]`, `[Theory(Skip = ...)]`.
    // Only `[Ignore]` was read, which is NUnit and MSTest, so bitwarden/server's **43 skipped tests
    // were reported as 1**. A team told their suite is sound while 43 of its tests never run is
    // worse off than a team told nothing at all.
    const skipped =
      /@(Disabled|Ignore)\b|\[\s*Ignore\b/.test(around) ||
      /\[\s*\w*(?:Fact|Theory)\s*\([^)]*\bSkip\s*=/.test(around) ||
      skipsUnconditionally(body);
    found.push({ name, line: lineAt(text, at), body, skipped, callback: '' });
  }
  return found;
}

/**
 * A `t.Skip()` that runs whatever happens: at the top level of the body, not inside an `if`. Go
 * tests commonly skip on one platform and run on the others, and calling those "never runs" is
 * wrong.
 */
function skipsUnconditionally(body: string): boolean {
  let depth = 0;
  for (const line of body.split(String.fromCharCode(10))) {
    const text = line.trim();
    // `t.Skip(...)` in Go: a short receiver, and a whole statement with nothing chained onto it.
    // `\w+\.Skip(` matched any identifier at all, so C#'s LINQ - `collections.Skip(1).ToList()`,
    // which is how .NET pages a sequence - read as a test turning itself off. bitwarden/server has
    // one, and it was the only never-runs Tewip reported there until xUnit's `[Fact(Skip = ...)]`
    // was understood; the real number was 43 and the one it had was wrong.
    if (depth === 0 && /^\w{1,3}\s*\.\s*Skip(f|Now)?\s*\([^)]*\)\s*;?\s*$/.test(text)) return true;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return false;
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

export { jsTests, pythonTests, rubyTests, bracedTests };
