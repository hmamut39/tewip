// Which tests actually reach the code a change touched.
//
// Two ways of knowing, in this order: a test that imports the changed file (directly, or through
// the package's front door) really does exercise it; a test whose name and path share the change's
// words probably does. The first is a fact, the second a guess, and the report says which is which -
// because "these 6 tests cover your change" is only useful if it is true.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { familyOf, importNames, importsIt, packageNames } from './imports.ts';
import { declaresATest } from '../vouch/is-a-test-file.ts';
import { languageOf } from '../vouch/tests-in.ts';

export { familyOf, importNames, importsCanBeFollowed, importsIt } from './imports.ts';

export interface TestCoverage {
  testFile: string;
  /** The changed files this test reaches. */
  covers: string[];
  /**
   * 'imports' when it imports the file itself; 'package' when it imports the package that
   * re-exports it, which still reaches the code; 'name' when only the words match, which is a guess.
   */
  how: 'imports' | 'package' | 'name';
}

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
const TEST_FILE = /(?:\.|_)(?:spec|test)\.[cm]?[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.py$|_test\.go$|Test(?:s)?\.(?:java|kt|cs)$|\.cy\.[jt]sx?$|\.feature$|\.robot$|_(?:spec|test)\.rb$|(?:Test|_test)\.php$|(?:^|[\\/])test_[^\\/]+\.rs$/i;
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

/**
 * Files a test could plausibly cover. Documentation, lockfiles and images change in almost every
 * pull request; saying "nothing tests ROADMAP.md" is noise, and noise is how a review gets skipped.
 */
export const isCode = (file: string): boolean =>
  /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|cs|php|rs|vue|svelte|scala|swift|sql)$/i.test(file) && !/(?:^|[\/])(?:package-lock\.json|yarn\.lock)$/i.test(file);

/**
 * Code a test could be expected to cover - which a test file and a declaration file are not.
 *
 * A changed test file is its own test, and a review that lists `fix-data.test.ts` as covering
 * `extension.test.ts` is saying nothing. A `.d.ts` has no behaviour at all: `version-compare.d.ts`
 * was matched to `perf.test.ts` because both contain the words "version" and "compare", and the
 * match was not wrong by the rule - the file simply should never have been asked about.
 */
export const isCoverableCode = (file: string): boolean => isCode(file) && !TEST_FILE.test(file) && !/\.d\.[cm]?ts$/i.test(file);


const words = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w));
const STOP = new Set(['src', 'lib', 'app', 'test', 'tests', 'spec', 'index', 'main', 'the', 'and', 'for', 'com', 'org', 'utils', 'util', 'js', 'ts', 'py']);

/**
 * A word that most test files contain is not evidence about any of them.
 *
 * Found by reading what `review` said about a real change to `extensions/vscode/engine-version.js`:
 * **eleven** test files were listed as covering it - `a2a`, `junit`, `perf`, `schema`, `write`,
 * `web-scan` - none of which has anything to do with the extension. Two shared words were required
 * and two were always found: *engine*, because every test lives in `engine/test/`, and *version*,
 * because fixtures everywhere say `schemaVersion: 1`. Both are structural noise. Fourteen of the
 * fifteen tests in that section were guesses and eleven were the same wrong guess, in the headline
 * section of the command - and a section that is mostly noise is a section a reviewer learns to skip.
 *
 * So a word is only evidence if it is rare across the test corpus, which is the rule `recall`
 * already uses on error text. A quarter is generous: 'engine' was in 100% of them.
 */
const NOISE_SHARE = 0.25;

function informative(byTest: Map<string, Set<string>>): (word: string) => boolean {
  const seen = new Map<string, number>();
  for (const bag of byTest.values()) for (const word of bag) seen.set(word, (seen.get(word) ?? 0) + 1);
  const limit = Math.max(2, Math.floor(byTest.size * NOISE_SHARE));
  return (word) => (seen.get(word) ?? 0) <= limit;
}

/**
 * The tests that reach a set of changed files. Imports first; then, for changed files nothing
 * imports, the tests whose words overlap - marked as a guess.
 */
export function coverageFor(root: string, changedAll: string[], tests = testFiles(root)): TestCoverage[] {
  const changed = changedAll.filter(isCoverableCode);
  const sources = new Map<string, string>();
  const read = (file: string): string => {
    if (!sources.has(file)) {
      try {
        sources.set(file, readFileSync(file, 'utf8'));
      } catch {
        sources.set(file, '');
      }
    }
    return sources.get(file)!;
  };

  const byTest = new Map<string, TestCoverage>();
  const coveredByImport = new Set<string>();
  const add = (test: string, file: string, how: TestCoverage['how']) => {
    const rel = relative(root, test).split(sep).join('/');
    const found = byTest.get(rel) ?? { testFile: rel, covers: [], how };
    // A test that imports the file itself is never downgraded to the weaker kinds of knowing.
    if (RANK[how] < RANK[found.how]) found.how = how;
    if (!found.covers.includes(file)) found.covers.push(file);
    byTest.set(rel, found);
  };

  for (const file of changed) {
    if (!existsSync(resolve(root, file))) continue;
    const direct = importNames(root, file);
    const viaPackage = packageNames(root, file);
    const family = familyOf(file);
    for (const test of tests) {
      // A test can only import a file its own language can import. Without this, a basename is
      // enough: see `familyOf`.
      if (family && familyOf(test) !== family) continue;
      const source = read(test);
      if (importsIt(source, direct)) {
        coveredByImport.add(file);
        add(test, file, 'imports');
      } else if (viaPackage.length > 0 && importsIt(source, viaPackage)) {
        coveredByImport.add(file);
        add(test, file, 'package');
      }
    }
  }

  // Only for the changed files nothing imports: the words, which is a weaker kind of knowing.
  const orphans = changed.filter((f) => !coveredByImport.has(f));
  if (orphans.length > 0) {
    const bags = new Map<string, Set<string>>();
    for (const test of tests) {
      const rel = relative(root, test).split(sep).join('/');
      bags.set(rel, new Set(words(`${rel} ${read(test).slice(0, 4000)}`)));
    }
    const isRare = informative(bags);
    for (const file of orphans) {
      // The file's own name, not its folders. A test that matches only on the directory a change
      // happens to live in knows nothing about the change.
      const named = new Set(words(basename(file)).filter(isRare));
      if (named.size === 0) continue;
      const wanted = new Set(words(file).filter(isRare));
      for (const test of tests) {
        const rel = relative(root, test).split(sep).join('/');
        if (byTest.has(rel)) continue;
        const bag = bags.get(rel) ?? new Set<string>();
        const shared = new Set([...wanted].filter((w) => bag.has(w)));
        // Two rare words, and at least one of them from the changed file's own name.
        if (shared.size < 2 || ![...named].some((w) => shared.has(w))) continue;
        add(test, file, 'name');
      }
    }
  }

  // Direct imports first, then the package ones - and inside each group the test whose words match
  // the change, because "every test in the library covers this" is true and useless.
  const overlap = (test: TestCoverage) => {
    const wanted = new Set(test.covers.flatMap((f) => words(f)));
    return words(test.testFile).filter((w) => wanted.has(w)).length;
  };
  return [...byTest.values()].sort((a, b) => RANK[a.how] - RANK[b.how] || overlap(b) - overlap(a) || b.covers.length - a.covers.length);
}

const RANK: Record<TestCoverage['how'], number> = { imports: 0, package: 1, name: 2 };

/**
 * Changed files that no test reaches at all: the part of a change nobody will notice breaking.
 *
 * The same rule as the coverage search, and for the same reason. "`version-compare.d.ts` has no
 * test that imports it. A mistake there would reach production unnoticed" is a sentence about a
 * file that declares types and executes nothing - a demand the reader cannot act on, in the section
 * meant to name the real risk of the change.
 */
export function uncovered(changed: string[], coverage: TestCoverage[]): string[] {
  const reached = new Set(coverage.flatMap((c) => c.covers));
  return changed.filter((f) => isCoverableCode(f) && !reached.has(f));
}
