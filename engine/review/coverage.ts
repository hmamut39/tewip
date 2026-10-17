// Which tests actually reach the code a change touched.
//
// Two ways of knowing, in this order: a test that imports the changed file (directly, or through
// the package's front door) really does exercise it; a test whose name and path share the change's
// words probably does. The first is a fact, the second a guess, and the report says which is which -
// because "these 6 tests cover your change" is only useful if it is true.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

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

const TEST_FILE = /(?:\.|_)(?:spec|test)\.[cm]?[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.py$|_test\.go$|Test(?:s)?\.(?:java|kt|cs)$|\.cy\.[jt]sx?$|\.feature$|\.robot$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.tewip', '.next']);

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
  if (!/\.(?:[cm]?[jt]sx?|py)$/i.test(path)) return false;
  try {
    return /\b(?:describe|it|test|context|suite)\s*\(|^\s*def\s+test_/m.test(readFileSync(path, 'utf8').slice(0, 8000));
  } catch {
    return false;
  }
}

/** Every test file in the project. */
export function testFiles(root: string, limit = 4000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIR.has(entry)) walk(path);
      } else if (TEST_FILE.test(entry) || declaresTests(dir, path)) out.push(path);
    }
  };
  walk(root);
  return out;
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

/** The module names a file can be imported by: its path, its name, and its folder's front door. */
export function importNames(root: string, changed: string): string[] {
  const full = resolve(root, changed);
  const noExt = full.slice(0, full.length - extname(full).length);
  const names = new Set<string>([basename(noExt), relative(root, noExt).split(sep).join('/')]);
  // Python: a.b.c for src/a/b/c.py, and the package it sits in.
  const parts = relative(root, noExt).split(sep).filter((p) => p !== 'src');
  names.add(parts.join('.'));
  names.add(parts.slice(0, -1).join('.'));
  if (basename(noExt) === 'index' || basename(noExt) === '__init__') names.add(basename(dirname(noExt)));
  return [...names].filter((n) => n.length > 1);
}

/**
 * The package a changed file is re-exported from. In a project with one front door - which is most
 * libraries - every test imports "../src" and nothing imports "../src/utils.ts", so without this a
 * review finds no tests at all for a real change. Measured: 8 of 16 real commits were missed this
 * way before.
 */
function packageNames(root: string, changed: string): string[] {
  const full = resolve(root, changed);
  const out: string[] = [];
  let dir = dirname(full);
  for (let up = 0; up < 3; up++) {
    for (const entry of ['index.ts', 'index.js', 'index.mjs', 'index.tsx', '__init__.py']) {
      const front = join(dir, entry);
      if (!existsSync(front)) continue;
      let source = '';
      try {
        source = readFileSync(front, 'utf8');
      } catch {
        continue;
      }
      const stem = basename(full).replace(/\.[^.]+$/, '');
      // Either it names this file, or it re-exports everything beside it.
      if (front !== full && (source.includes(stem) || /export\s+\*/.test(source))) {
        out.push(relative(root, dir).split(sep).join('/'), basename(dir));
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(out)].filter(Boolean);
}

/** Does this source import that file? Exported so the prover can follow imports further. */
export function importsIt(source: string, names: string[]): boolean {
  for (const name of names) {
    const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:from|import|require\\()\\s*['"][^'"]*${quoted}(?:\\.[cm]?[jt]sx?)?['"]`),
      new RegExp(`(?:^|\\n)\\s*(?:from\\s+${quoted}\\s+import|import\\s+${quoted})\\b`),
    ];
    if (patterns.some((p) => p.test(source))) return true;
  }
  return false;
}

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
    for (const test of tests) {
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
