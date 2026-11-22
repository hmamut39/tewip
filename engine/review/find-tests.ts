// Finding the test files of a project: which files are tests, and whether the walk saw them all.
//
// Split out of coverage.ts in Phase 219, when this took that file past the project's 300-line
// rule. The seam is the right one: this answers "what is a test here", and coverage.ts answers
// "which of them reaches the code that changed".
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { declaresATest } from '../vouch/is-a-test-file.ts';
import { languageOf } from '../vouch/tests-in.ts';

/**
 * A file whose own name says it is a test, in any language this reads.
 *
 * Ruby, PHP and Rust were absent, and this is the function that decides what is allowed to cover a
 * change: `testFiles` found **0 of discourse's 1,954 `_spec.rb`** (the 765 it found there are all
 * JavaScript), 0 of firefly-iii's 46 PHP tests and 0 of ripgrep's `tests/*.rs`. Ruby has been in
 * `languageOf` since Phase 36 and `vouch` reads discourse's 54,136 assertions on every corpus run.
 *
 * The name is checked before any directory rule, and that order is the fix for the other half:
 * `tests/integration/Support/Models/BillDateCalculatorTest.php` was thrown away because
 * `NOT_TESTS` below excludes a path containing `Support`, which there is the *subject under test* -
 * firefly-iii mirrors `app/Support/` in its test tree. 24 of its 46 went that way. A file called
 * `...Test.php` is a test whatever folder it sits in. Phase 218.
 */
export const TEST_FILE = /(?:\.|_)(?:spec|test)\.[cm]?[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.py$|_test\.go$|Test(?:s)?\.(?:java|kt|cs)$|\.cy\.[jt]sx?$|\.feature$|\.robot$|_(?:spec|test)\.rb$|(?:Test|_test)\.php$|(?:^|[\\/])test_[^\\/]+\.rs$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.tewip', '.next']);

/** Already inside a test tree, where a build-output name is somebody's source folder. */
const underTests = (dir: string): boolean =>
  /(?:^|[/\\])(?:tests?|spec|specs|__tests__)(?:[/\\]|$)/i.test(dir);

/**
 * A test file that does not say so in its name.
 *
 * Mocha's convention - and most of the JavaScript world before ~2018 - is `test/utils.js`, with no
 * suffix at all. Requiring `.test.js` meant every Mocha project looked like a project with no tests:
 * express has 88 of them, and Tewip reported that nothing covered any file in it. The name is checked
 * first because it is free; only a file already sitting in a test folder is opened to be sure.
 */
function declaresTests(dir: string, path: string): boolean {
  const where = dir.split(String.fromCharCode(92)).join('/');
  if (!/(?:^|\/)(?:tests?|spec|specs|__tests__)(?:\/|$)/i.test(where)) return false;
  if (/(?:^|\/)(?:fixtures?|support|helpers?|mocks?|__mocks__|data|snapshots?)(?:\/|$)/i.test(where)) return false;
  // Every language the project reads tests in, not the three this had, and asked with the reader
  // `vouch` uses rather than a second pattern written here.
  //
  // The old regex was `\b(?:describe|it|test|context|suite)\s*\(` over `.js`, `.ts` and `.py`.
  // It could not see Rust's `#[test]`, so ripgrep's `tests/*.rs` were invisible; and it would have
  // called a PHP production controller a test file for `public function testRule(`, which is an
  // endpoint a user hits to try a rule. `declaresATest` knows both, and knows that a directory
  // called `Test` is not evidence - which is why it is that function and not `looksLikeTests`.
  // Phase 218.
  if (languageOf(path) === null) return false;
  // Rust, by Cargo's own rule rather than by a pattern: every `.rs` file under a `tests/`
  // directory is compiled as an integration test crate. 14 of ripgrep's 18 declare their tests
  // through `rgtest!`, a macro of its own that expands to `#[test]`, so nothing read out of the
  // text will ever find them - and chasing one project's macro name is not a rule. Where the
  // language says a file in this folder is a test, that is the better authority.
  if (/\.rs$/i.test(path)) return true;
  try {
    return declaresATest(path, readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/** Every test file in the project. */
/**
 * Far enough out that no real project reaches it, and it says so when one does.
 *
 * The bound was 4,000 and the walk returned the first 4,000 it happened to meet, as a list with
 * nothing to distinguish it from a complete one. **n8n has 8,308 test files and this returned
 * 4,003**, which was true before any of Phase 218 and invisible because the number was never
 * compared with anything. discourse went over the same line the moment Ruby became visible: 4,873
 * found, 4,057 returned. Everything downstream - what covers a change, what to re-run, what to
 * prove - was being decided against half a suite.
 *
 * Lifting it costs 2.2s on n8n and nothing on discourse, measured. A bounded look reported as a
 * total is Phase 185 exactly, so the bound is still here and the flag is how it stops being a lie.
 */
const CAP = 20000;

/** Every test file in the project, and whether the walk gave up before the end. */
export function testFilesFound(root: string, limit = CAP): { files: string[]; stoppedEarly: boolean } {
  const out: string[] = [];
  let stoppedEarly = false;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Per file, not per directory. Checking only on entry to `walk` let a single folder run past
      // the bound by as many files as it held - n8n returned 4,003 against a bound of 4,000 and
      // discourse 4,057 - and a walk that overshoots can also finish a directory and never notice
      // it was bounded at all, which is the flag below reading false on a truncated list.
      if (out.length >= limit) {
        stoppedEarly = true;
        return;
      }
      const path = join(dir, entry);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        // Skipped by name, except inside a test tree, where the name is the subject.
        //
        // `coverage`, `build`, `out`, `target` and `dist` are skipped because they are usually
        // build output. They are also ordinary names for real code: discourse keeps eight specs
        // for its coverage tooling in `migrations/tooling/spec/lib/migrations/tooling/coverage/`,
        // and they were thrown away by the word `coverage`. Nothing a build wrote ever sits under
        // `spec/` or `tests/`, so inside one the name carries no such warning. Phase 218.
        if (!SKIP_DIR.has(entry) || underTests(dir)) walk(path);
      } else if (TEST_FILE.test(entry) || declaresTests(dir, path)) out.push(path);
    }
  };
  walk(root);
  return { files: out, stoppedEarly };
}

/** The same walk, for the callers that only need the list. */
export const testFiles = (root: string, limit = CAP): string[] => testFilesFound(root, limit).files;
