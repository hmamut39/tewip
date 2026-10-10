// Which tests reach a file, following imports further than one step.
//
// This exists because the first honest run of `tewip prove` on Tewip's own code answered "no test
// imports this file, so nothing could notice a change" - about a file with 25 tests behind it. They
// import `vouch.ts`, which imports `assertions.ts`, and one step of import-following cannot see that.
// In any codebase with layers, most files are reached through another module, so a prover that only
// understands direct imports says "not covered" about nearly everything and is worthless.
//
// The chain is followed outwards from the file, not inwards from the tests, because the answer needed
// is "who would notice if this changed" and that is what a reverse import graph gives.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { importNames, importsIt } from '../review/coverage.ts';

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.tewip', '.next']);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|rb)$/i;

/** Every source file here, so "who imports this" can be answered without a build system. */
function sourceFiles(root: string, limit = 6000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
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
      } else if (SOURCE.test(entry)) out.push(path);
    }
  };
  walk(root);
  return out;
}

/**
 * The package's front door: the files a test means when it writes `require('..')`.
 *
 * This matters for selection and nothing else. express's tests all do `require('..')`, which resolves
 * through `index.js` to `lib/express.js` and from there to every part of the library - so a change to
 * `lib/response.js` really is reachable from almost every test in the project. Without this, selection
 * followed the chain as far as `index.js`, found that no test imports *that* by name, and cheerfully
 * declared 86 of express's 88 test files unaffected by a change to the response code.
 */
function frontDoor(root: string): Set<string> {
  const files = new Set<string>();
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { main?: string };
    if (manifest.main) files.add(resolve(root, manifest.main));
  } catch {
    // No manifest: the conventional entry points below still apply.
  }
  for (const entry of ['index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.tsx', '__init__.py', 'src/index.js', 'src/index.ts']) {
    if (existsSync(resolve(root, entry))) files.add(resolve(root, entry));
  }
  return files;
}

/** Every path this file imports, as written. */
const importedPaths = (text: string): string[] => [...text.matchAll(/(?:from|require\s*\(|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

/**
 * Does this file import the package's front door?
 *
 * Decided by **resolving** each import against the file's own directory, not by recognising spellings.
 * Guessing at spellings had already missed one: express's `test/res.status.js` imports `require('../.')`,
 * which is the package root written a slightly unusual way, and the selection declared that file
 * unaffected by a change to the very module `res.status` lives in. A false skip is the one failure this
 * command must not have, so the question is answered by path resolution, which cannot be spelled around.
 */
function importsFrontDoor(root: string, file: string, text: string, doors: Set<string>): boolean {
  const here = dirname(resolve(root, file));
  for (const spec of importedPaths(text)) {
    if (!spec.startsWith('.')) continue;
    const target = resolve(here, spec);
    if (target === resolve(root)) return true; // the package root itself
    for (const ending of ['', '.js', '.ts', '.mjs', '.cjs', '.tsx', '/index.js', '/index.ts', '/index.mjs', '/index.cjs', '/index.tsx', '/__init__.py']) {
      if (doors.has(resolve(`${target}${ending}`))) return true;
    }
  }
  return false;
}

export function allTestsReaching(root: string, file: string, tests: string[], depth = 6): Reach[] {
  const all = sourceFiles(root);
  const text = new Map<string, string>();
  const read = (path: string): string => {
    if (!text.has(path)) {
      try {
        text.set(path, readFileSync(path, 'utf8'));
      } catch {
        text.set(path, '');
      }
    }
    return text.get(path)!;
  };
  const rel = (path: string) => relative(root, path).split(String.fromCharCode(92)).join('/');
  const testSet = new Set(tests.map((t) => rel(resolve(root, t))));
  const found = new Map<string, Reach>();
  const seen = new Set<string>([rel(resolve(root, file))]);
  const doors = frontDoor(root);
  let layer = [file];

  for (let step = 1; step <= depth && layer.length > 0; step += 1) {
    // Reached the package's own entry point. Everything that imports the package now reaches the change -
    // and that includes modules, not only tests: express's acceptance tests import an example app, which
    // imports the package, so stopping at tests here left nineteen of them looking unaffected.
    if (layer.some((f) => doors.has(resolve(root, f)))) {
      const throughDoor: string[] = [];
      for (const path of all) {
        const where = rel(path);
        if (seen.has(where) || !importsFrontDoor(root, where, read(path), doors)) continue;
        seen.add(where);
        if (testSet.has(where)) found.set(where, { testFile: where, steps: step, via: 'the package itself' });
        else throughDoor.push(where);
      }
      layer = [...layer, ...throughDoor];
    }
    const names = layer.flatMap((f) => (existsSync(resolve(root, f)) ? importNames(root, f) : []));
    if (names.length === 0) break;
    const next: string[] = [];
    for (const path of all) {
      const where = rel(path);
      if (seen.has(where)) continue;
      if (!importsIt(read(path), names)) continue;
      seen.add(where);
      if (testSet.has(where)) found.set(where, { testFile: where, steps: step, via: layer[0] });
      // A module that imports the change is itself a way in, whether or not it is a test, so the walk
      // continues through it. This is what reaches a test that only imports the package front door.
      next.push(where);
    }
    layer = next;
  }
  return [...found.values()];
}

export interface Reach {
  /** The test file, relative to the root. */
  testFile: string;
  /** How far the chain of imports is: 1 when the test imports the file itself. */
  steps: number;
  /** The chain, for the report: the test imports this, which imports the file. */
  via: string;
}

/**
 * The tests that reach `file`, directly or through up to `depth` modules.
 *
 * Every hop is a real import found in the source, so this stays a fact rather than a guess - the
 * distinction the rest of Tewip keeps. It stops at the first depth that finds anything: a test one
 * step away is a better witness than fifty tests four steps away, and running fifty test files to
 * answer one question is how a command becomes too slow to use.
 */
export function testsReaching(root: string, file: string, tests: string[], depth = 3): Reach[] {
  const all = sourceFiles(root);
  const text = new Map<string, string>();
  const read = (path: string): string => {
    if (!text.has(path)) {
      try {
        text.set(path, readFileSync(path, 'utf8'));
      } catch {
        text.set(path, '');
      }
    }
    return text.get(path)!;
  };

  const rel = (path: string) => relative(root, path).split(String.fromCharCode(92)).join('/');
  const testSet = new Set(tests.map((t) => rel(resolve(root, t))));
  const seen = new Set<string>([rel(resolve(root, file))]);
  // What the chain is: layer 0 is the file, layer 1 the modules importing it, and so on.
  let layer = [file];

  for (let step = 1; step <= depth; step += 1) {
    const names = layer.flatMap((f) => (existsSync(resolve(root, f)) ? importNames(root, f) : []));
    if (names.length === 0) break;

    const found: Reach[] = [];
    const next: string[] = [];
    for (const path of all) {
      const where = rel(path);
      if (seen.has(where)) continue;
      if (!importsIt(read(path), names)) continue;
      seen.add(where);
      if (testSet.has(where)) found.push({ testFile: where, steps: step, via: layer.length === 1 ? layer[0] : `${layer[0]} and ${layer.length - 1} more` });
      else next.push(where);
    }
    // Something at this distance can see the change: stop, rather than dragging in the whole tree.
    if (found.length > 0) return found;
    if (next.length === 0) break;
    layer = next;
  }
  return [];
}
