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
import { join, relative, resolve } from 'node:path';
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
