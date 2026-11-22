// Is this file tests at all? The gate in front of every test reader.
//
// Split out of tests-in.ts in Phase 200, which that file's own header predicted: it keeps the
// questions every language shares, and this is one of them grown large enough to answer on its
// own. It grew because it was wrong in a way nothing could see.
//
// `vouch` judges nothing this refuses, and `tewip start` - the front door - counts what it accepts
// and prints the count as "N test files here". Those two consequences are not symmetrical, and the
// asymmetry is the whole design of this file:
//
//   refuse a real test file  ->  it vanishes, and so does any verdict about it
//   accept a source file     ->  `vouch` reads it, finds no test and drops it, so the verdict
//                                survives - but the front door's count does not, because it has no
//                                reader behind it to absorb the mistake
//
// Measured in Phase 200 on this repository: **298 test files reported against a real 133**, a tool
// built out of regular expressions matching the `.test(` it calls in nearly every file it has. The
// one number a new user has no way to check, wrong by a factor of two, on the project that wrote
// it. Both directions are measured in `eval/test-file-recall.ts`.
import { isText, languageOf, textRanges } from './tests-in.ts';

/**
 * Minified or vendored: a file nobody in this project wrote, and nobody is going to fix.
 *
 * firefly-iii ships `public/v1/lib/jquery-4.0.0.min.js`, and minified JavaScript is full of `test(`
 * - it is how a regular expression is applied - so it read as a test file and was judged as one.
 * Nothing useful can come of that: the author cannot act on it, and it is not their code.
 *
 * Length is the signal rather than the name, because plenty of vendored bundles are not called
 * `.min.js`. A minified file is one enormous line; source is not.
 */
function minifiedOrVendored(file: string, text: string): boolean {
  if (/[.-]min\.(js|css|mjs)$/i.test(file)) return true;
  if (/(^|[\/])(vendor|third[_-]?party|bundles?|dist)[\/]/i.test(file)) return true;
  const lines = text.split(String.fromCharCode(10));
  const longest = lines.reduce((most, line) => Math.max(most, line.length), 0);
  return longest > 2000 && text.length / Math.max(lines.length, 1) > 400;
}

/**
 * Does this pattern match the file's **code**, rather than its prose?
 *
 * `textRanges` below has masked strings and comments since Phase 22, for the extractor: without it,
 * a fixture quoting a fake test was judged as one. The gate in front of the extractor never used
 * it, so the gate was answering a different question from the thing it guards.
 *
 * What that cost, measured in Phase 200 on Tewip's own repository: 52 source files declared
 * test-shaped on the strength of English. `${n} test(s) attempted` - the plural idiom in an output
 * string - matches `test\s*\(`, and a comment reading "the selector no longer finds it (renamed)"
 * matches `it\s*\(`. A tool that writes sentences about tests mentions them constantly.
 */
function inCode(text: string, ranges: Array<[number, number]>, pattern: RegExp): boolean {
  for (const hit of text.matchAll(pattern)) {
    const at = hit.index ?? 0;
    // Past the indentation, so a match anchored with `^\s*` is judged where its keyword is.
    if (!isText(ranges, at + (hit[0].length - hit[0].trimStart().length))) return true;
  }
  return false;
}

/** The declaration shapes that are code. `* @test` is deliberately absent: it **is** a comment. */
const DECLARED_IN_CODE = /(?<![.\w$#])(it|test|describe|Scenario)\s*\(|^\s*def\s+test_|@Test\b|\[(Test|Fact|Theory)\]|\bfunc\s+Test[A-Z]/gm;

/**
 * Does this file declare a test, read out of the file itself?
 *
 * Separate from `looksLikeTests` because that one takes a directory as proof, and a directory
 * proves nothing. firefly-iii has eleven production classes under `app/Events/Test/`,
 * `app/Listeners/Test/` and `app/Notifications/Test/` - the Laravel feature that sends a user a
 * test notification - and every one of them was a test file on the strength of a folder called
 * `Test`. Not one extends a `TestCase` or carries an attribute, which is what this asks.
 *
 * `looksLikeTests` keeps the shortcut, because for vouching a file in a test folder named like a
 * test is a test and the masking below is the expensive part. Discovery cannot afford the
 * shortcut: it decides what is allowed to cover a change. Phase 218.
 */
export function declaresATest(file: string, text: string): boolean {
  if (minifiedOrVendored(file, text)) return false;
  if (/[.-]config\.[cm]?[jt]s$/i.test(file)) return false;
  return declaresIn(file, text);
}

/** Does this file look like tests at all? Vouching for a source file is a category error. */
export function looksLikeTests(file: string, text: string): boolean {
  if (minifiedOrVendored(file, text)) return false;
  // A configuration file is not a test file, wherever it sits.
  //
  // `e2e/playwright.config.ts` sits under a directory the `named` pattern below claims outright,
  // and declares no test at all - it declares where the tests are. Found in Phase 200 by pointing
  // the front door at a real project: it was one of five files there that were counted as tests
  // and are not.
  if (/[.-]config\.[cm]?[jt]s$/i.test(file)) return false;
  const named = /(^|[\\/])(tests?|spec|specs|__tests__|e2e|it|integration)[\\/]|[._-](test|tests|spec|specs|it)\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs|scala)$/i.test(file);
  // Named like a test? Then nothing below can change the answer, and the masking it needs is the
  // one expensive thing this function does. Same result, and it runs only where it decides.
  if (named) return true;
  return declaresIn(file, text);
}

/** The content half: every way a declaration of a test shows up in the eight languages. */
function declaresIn(file: string, text: string): boolean {
  const language = languageOf(file);
  const ranges = textRanges(text, language ?? undefined);
  const declares =
    // `(?<![.\w$#])` and not `\b`: a method call is not a declaration.
    //
    // `/[a-z]+/.test(value)` is how JavaScript asks whether a pattern matches, and `\btest\s*\(`
    // matched the `test(` inside it, because the `.` before it is a word boundary. So any file
    // applying a regular expression read as a test file. `minifiedOrVendored` above already
    // names this exact idiom as the reason a vendored jQuery bundle was judged as tests, and
    // answered it by length - which covers minified files and nothing else.
    //
    // Measured on Tewip's own repository in Phase 200, where it is not a corner case: the front
    // door reported **298 test files against a real 133**, because a tool built out of regular
    // expressions calls `.test(` in nearly every file it has. The one number a new user has no
    // way to check, wrong by a factor of two, on the project that wrote it.
    inCode(text, ranges, DECLARED_IN_CODE) ||
    // Ruby, PHP and Rust, added in Phase 36. PHPUnit names a test `testSomething`, so the `test\s*\(`
    // above never matched it, and Rust marks one with an attribute no pattern here knew. Both came
    // back as "0 test(s) read in 0 file(s)", which reads like a clean answer and is not one.
    /#\s*\[\s*(?:test|tokio::test|rstest)\s*\]/.test(text) ||
    // `public`, or no modifier at all: PHPUnit runs public methods and nothing else. Without that,
    // firefly-iii's `private function testing()` - a middleware helper asking whether the app is in
    // the test environment - made `app/Http/Middleware/InterestingMessage.php` a test file, and the
    // whole of that production class was judged as tests. Vouching for source code is a different
    // question, and this file says so three lines further down.
    // A PHP method called `test*` is not a PHPUnit test. firefly-iii has eight public ones in
    // production controllers - `testRule`, `testNotification` - which are endpoints a user hits to
    // try a rule or send a test notification, and every one of them made its controller a test file.
    // What makes a PHPUnit test is the class it is in, so that is what is asked for: a TestCase to
    // extend, or the attribute and annotation forms that need no base class.
    (/#\s*\[\s*Test\b|\*\s*@test\b/.test(text) ||
      (/(?:^|[^\w$>])(?:public\s+)?(?:static\s+)?function\s+test\w*\s*\(/m.test(text) &&
        /\bextends\s+\w*TestCase\b|\buse\s+PHPUnit\{2}Framework/.test(text))) ||
    // RSpec, in Ruby only, and only where it opens a block.
    //
    // Two things were wrong with asking this of every language. `context` is an ordinary variable
    // name, and `^\s*(?:describe|context)\s+` matched **`context = {`** - a dictionary assignment
    // in a Python file - so `app/ai_service.py`, 500 lines of prompt building, was a test file.
    // Nothing about RSpec's syntax is legal in Python or JavaScript, so asking at all was the
    // error; requiring the `do` that makes it a block is what makes it right within Ruby too,
    // where `context = {}` is just as ordinary.
    (languageOf(file) === 'ruby' &&
      /^\s*(?:RSpec\.)?(?:describe|context)\s+[^=\n]*\sdo\b|^\s*(?:x|f)?it\s+["'].*\bdo\b/m.test(text));
  return declares;
}
