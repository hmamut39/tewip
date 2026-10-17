// Running the mutants: break one thing, run the tests that cover it, put the file back.
//
// This is the only part of Tewip that writes to a file the developer did not ask it to touch, so the
// restoring is not a detail, it is the feature. The rules:
//
//   - the original bytes are held in memory before anything is written;
//   - the file is put back in a `finally`, whatever happened, including a crash or a timeout;
//   - after putting it back, the bytes are compared, and a mismatch is reported loudly rather than
//     shrugged off, because the alternative is leaving somebody's code broken on disk;
//   - the tests are run unmutated first. If they do not pass as they are, nothing is proved and
//     nothing is mutated at all.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Framework } from '../quality/frameworks.ts';
import { runTest } from '../quality/write-verify.ts';
import { applyMutant, candidateMutants, spread, type Mutant } from './mutants.ts';

/**
 * Does this mutated file still parse?
 *
 * The first version judged this by looking for words like "SyntaxError" or "no such file" in the test
 * output, and it was wrong on the first real project it met: express's own static-file tests print
 * ENOENT messages when they pass, so four valid mutants in `lib/utils.js` were thrown away as "did
 * not compile" and the report claimed nothing could be shown. Reading a test's output to guess why it
 * failed is precisely the habit this project exists to replace.
 *
 * Every operator here is syntax-preserving by construction, so a parse failure should be impossible.
 * Where the language has a cheap exact check, it is used anyway - being sure costs 40 milliseconds.
 */
function stillParses(full: string): boolean {
  if (!/\.(js|cjs|mjs)$/i.test(full)) return true;
  const checked = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8', timeout: 20_000 });
  return checked.status === 0;
}

export type Fate =
  | 'noticed' // a covering test failed: the suite would catch this mistake
  | 'unnoticed' // every covering test still passed: a hole
  | 'did-not-compile' // the change was not valid code, so it proves nothing about the tests
  | 'runner-broke'; // the environment, not the tests

export interface Tried {
  mutant: Mutant;
  fate: Fate;
  /** The test that noticed, when one did. */
  noticedBy: string;
  /** Seconds this mutant took, so the cost of the answer is visible. */
  seconds: number;
}

export interface Proof {
  file: string;
  /** The test files that import this file, which are the only ones that could notice. */
  covering: string[];
  tried: Tried[];
  /** Why nothing could be proved, when nothing could. */
  blocked: string;
  /** Covering tests that were set aside because they do not pass as they are, and why. */
  setAside: Array<{ test: string; why: string }>;
  /** Mutants that were generated but not run, because the time budget ran out. */
  notTried: number;
  /**
   * Every change this file allows, not only the ones tried. `--limit` samples; without this number
   * a report on 6 of 20 changes reads like a report on the file.
   */
  found: number;
  seconds: number;
}

export interface ProveOptions {
  /** How many changes to try. More is a better answer and a longer wait. */
  limit?: number;
  /** Total seconds to spend before stopping and saying so. */
  budgetSeconds?: number;
  /** Seconds for one test run. */
  runSeconds?: number;
  /** Called before each run, so a long job says what it is doing. */
  onStep?: (message: string) => void;
}

/**
 * Proves what the tests covering `file` would and would not catch.
 *
 * `covering` is decided by the caller, from which tests really import the file: a test matched only
 * by its name might not exercise the code at all, and running it would produce a confident answer
 * about nothing.
 */
/**
 * Do the tests actually load this file?
 *
 * They may not, and the first Python project this met proved it: in a src-layout repository `import
 * humanize` resolved to a different checkout entirely, so editing `src/humanize/filesize.py` changed
 * nothing the tests ran. Every mutant survived and the report said five changes went unnoticed - a
 * confident, completely false accusation against a suite that is in fact thorough.
 *
 * So before any survival is believed, the file is broken on purpose in a way nothing can survive, and
 * a covering test is run. If it still passes, the tests are reading some other copy - an installed
 * package, a build output, a stale bundle - and the honest answer is to say so and stop. This is the
 * same control the write gate uses: a check that cannot fail proves nothing, and neither does a test
 * that cannot see the code.
 */
function testsLoadIt(root: string, full: string, original: string, test: string, framework: Framework, runMs: number): boolean {
  const control = /\.py$/i.test(full)
    ? `raise RuntimeError("tewip control")${String.fromCharCode(10)}${original}`
    : /\.(js|cjs|mjs|ts|tsx|mts|cts|jsx)$/i.test(full)
      ? `throw new Error("tewip control");${String.fromCharCode(10)}${original}`
      : `!!tewip-control!!${String.fromCharCode(10)}${original}`;
  try {
    writeFileSync(full, control, 'utf8');
    return !runTest(framework, resolve(root, test), runMs).passed;
  } finally {
    restore(full, original);
  }
}

export function proveFile(root: string, file: string, covering: string[], framework: Framework, opts: ProveOptions = {}): Proof {
  const started = Date.now();
  const limit = opts.limit ?? 6;
  const budget = (opts.budgetSeconds ?? 600) * 1000;
  const runMs = (opts.runSeconds ?? 180) * 1000;
  const say = opts.onStep ?? (() => {});
  const full = resolve(root, file);
  const proof: Proof = { file, covering, tried: [], blocked: '', setAside: [], notTried: 0, found: 0, seconds: 0 };

  if (covering.length === 0) {
    proof.blocked = 'no test imports this file, so no test could notice any change to it. That is the finding: this code is not covered by anything Tewip can name.';
    return finish(proof, started);
  }

  const original = readFileSync(full, 'utf8');
  const stopGuarding = guardAgainstBeingKilled(full, original);
  // The whole set first, then the sample: `found` is what the file allows and `mutants` is what
  // there was time to ask about, and the report has to be able to tell the reader the difference.
  const candidates = candidateMutants(original);
  const mutants = spread(candidates, limit);
  proof.found = candidates.length;
  if (mutants.length === 0) {
    proof.blocked = 'nothing in this file could be changed in a way a test should be expected to catch - no comparison, no condition, no returned value outside of strings and comments';
    return finish(proof, started, stopGuarding);
  }

  // A test has to pass before it can be asked to notice anything, or a red suite turns into "your
  // tests catch nothing", which is the worst kind of lie this command could tell.
  //
  // One bad file does not stop the answer, though. In python-humanize six test files cover
  // filesize.py and one of them needs a pytest plugin that is not installed - refusing the whole
  // question over that told the developer nothing, while the other five were ready to answer it. So
  // the ones that cannot run are set aside by name, and only an empty list blocks.
  const usable: string[] = [];
  for (const test of covering) {
    say(`checking ${test} passes as it is`);
    const before = runTest(framework, resolve(root, test), runMs);
    if (before.passed) usable.push(test);
    else proof.setAside.push({ test, why: before.environment ? `the runner broke: ${firstLine(before.output)}` : before.skipped ? 'every test in it was skipped' : 'it does not pass as it is' });
  }
  if (usable.length === 0) {
    proof.blocked = `none of the ${covering.length} test file(s) covering this pass as they are, so none can be asked whether they would notice a change. Fix the run first.`;
    return finish(proof, started, stopGuarding);
  }
  proof.covering = usable;

  // The control: break the file outright and check that a covering test notices. Without this, a file
  // the tests never load would produce a full report of things they "failed to catch".
  say('checking the tests really load this file');
  if (!testsLoadIt(root, full, original, usable[0], framework, runMs)) {
    proof.blocked = `${usable[0]} passes even when this file is made unusable, so the tests are not loading the file that was edited - they are reading an installed copy or a build output. Nothing here can be proved until they run against this source (for a Python src layout, install it in editable mode: pip install -e .).`;
    return finish(proof, started, stopGuarding);
  }
  // Only the tests that pass may judge a mutant. A test that is already failing fails for every
  // change too, which would have it "catch" everything - the exact false confidence this command
  // exists to remove. It reported five catches by a set-aside file once; never again.

  for (const mutant of mutants) {
    if (Date.now() - started > budget) {
      proof.notTried = mutants.length - proof.tried.length;
      break;
    }
    const at = Date.now();
    say(`${mutant.kind}, line ${mutant.line}`);
    let fate: Fate = 'unnoticed';
    let noticedBy = '';
    try {
      writeFileSync(full, applyMutant(original, mutant), 'utf8');
      if (!stillParses(full)) {
        fate = 'did-not-compile';
      } else {
        for (const test of usable) {
          const result = runTest(framework, resolve(root, test), runMs);
          if (result.environment) {
            fate = 'runner-broke';
            break;
          }
          // A failing test is a test that noticed, whatever it printed. An exception thrown by the
          // changed code is the suite catching the change, not an excuse to discard the mutant.
          if (!result.passed) {
            fate = 'noticed';
            noticedBy = test;
            break;
          }
        }
      }
    } catch (error) {
      fate = 'did-not-compile';
      noticedBy = error instanceof Error ? error.message.slice(0, 120) : '';
    } finally {
      restore(full, original);
    }
    proof.tried.push({ mutant, fate, noticedBy, seconds: Math.round((Date.now() - at) / 100) / 10 });
  }

  return finish(proof, started, stopGuarding);
}

/**
 * Puts the file back and checks that it really went back. Anything less would mean this command can
 * leave somebody's source broken, which would make it unusable however good its answers were.
 */
function restore(full: string, original: string): void {
  writeFileSync(full, original, 'utf8');
  if (readFileSync(full, 'utf8') !== original) {
    throw new Error(`${full} could not be put back as it was. Check it before doing anything else: git checkout -- "${full}"`);
  }
}

/**
 * Put the file back even when the process is killed.
 *
 * `finally` does not run for SIGINT or SIGTERM, so a developer pressing Ctrl-C during a run - which they
 * will, because this is the slow command - was left with a mutated source file and no idea why their
 * code had stopped working. Found by killing one of these runs during development and finding a flipped
 * comparison still sitting in the repository.
 */
function guardAgainstBeingKilled(full: string, original: string): () => void {
  const putBack = (signal: NodeJS.Signals) => () => {
    try {
      restore(full, original);
      process.stderr.write(`${String.fromCharCode(10)}${signal}: ${full} was put back as it was.${String.fromCharCode(10)}`);
    } catch {
      process.stderr.write(`${String.fromCharCode(10)}${signal}: could not put ${full} back. Run: git checkout -- "${full}"${String.fromCharCode(10)}`);
    }
    process.exit(130);
  };
  const handlers: Array<[NodeJS.Signals, () => void]> = (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as NodeJS.Signals[]).map((signal) => [signal, putBack(signal)]);
  for (const [signal, handler] of handlers) {
    try {
      process.on(signal, handler);
    } catch {
      // Not every signal exists on every platform.
    }
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

const finish = (proof: Proof, started: number, stopGuarding?: () => void): Proof => {
  stopGuarding?.();
  return { ...proof, seconds: Math.round((Date.now() - started) / 1000) };
};

const firstLine = (output: string): string => output.split(String.fromCharCode(10)).map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '';

/** Which of the tests that cover a file really import it, and so could notice a change. */
export function importingTests(root: string, coverage: Array<{ testFile: string; covers: string[]; how: string }>, file: string): string[] {
  const wanted = file.split('\\').join('/');
  return coverage
    .filter((c) => c.how !== 'name' && c.covers.some((covered) => covered.split('\\').join('/') === wanted))
    .map((c) => relative(root, join(root, c.testFile)).split('\\').join('/'));
}
