// Which tests actually reach the code a change touched.
//
// Two ways of knowing, in this order: a test that imports the changed file (directly, or through
// the package's front door) really does exercise it; a test whose name and path share the change's
// words probably does. The first is a fact, the second a guess, and the report says which is which -
// because "these 6 tests cover your change" is only useful if it is true.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { familyOf, importNames, importsIt, packageNames } from './imports.ts';
import { TEST_FILE, testFiles, testFilesFound } from './find-tests.ts';

export { testFiles, testFilesFound } from './find-tests.ts';

export { familyOf, importNames, importsCanBeFollowed, importsIt } from './imports.ts';
import { importsCanBeFollowed } from './imports.ts';

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
  return changed.filter((f) => isCoverableCode(f) && !reached.has(f) && importsCanBeFollowed(f));
}

/**
 * Changed files nothing reached because their language expresses no import this can read.
 *
 * The same false accusation Phase 217 took out of `tewip done`, left standing in `tewip review`
 * for one more phase. On bitwarden's change to `src/Core/Constants.cs` the review said it three
 * ways at once: "1 changed file(s) have no test that imports them ... **A mistake there would
 * reach production unnoticed**", "**No test in this project reaches any of the changed files.**
 * Tewip can write one", and a section headed "Changed, but nothing tests it". 63 files under
 * `test/` name the types declared in that file, and the offer was to write a test for code that
 * already has sixty-three.
 *
 * `importsCanBeFollowed` has the measurement: 0 of 25 sampled files resolved an import in C#, Go,
 * Java or Ruby, against 1,958 keycloak test files and 1,173 of bitwarden's. Phase 219.
 */
export function notRead(changed: string[], coverage: TestCoverage[]): string[] {
  const reached = new Set(coverage.flatMap((c) => c.covers));
  return changed.filter((f) => isCoverableCode(f) && !reached.has(f) && !importsCanBeFollowed(f));
}
