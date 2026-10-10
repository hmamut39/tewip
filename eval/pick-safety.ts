// Is `tewip pick` safe? Measured by breaking the code and checking the narrowed run still notices.
//
// A selection tool has exactly one failure that matters: dropping the test that would have caught the
// bug. Vendors report "tests saved" and leave safety to a confidence interval. That is the wrong number
// to publish first, so this measures safety directly, and treats the saving as the secondary figure.
//
// The method, per source file:
//   1. Make a real change to it - one of `prove`'s mutants, which is a mistake a person actually makes.
//   2. Ask `pick` which tests could notice that change, from the facts in the source.
//   3. Run the **whole** suite and record which test files failed. Those are the tests that really catch
//      this mistake, decided by execution.
//   4. A mutant is a safety failure if the suite caught it and the selection did not include a single
//      test that caught it. A mutant nothing caught says nothing about selection and is excluded.
//
// Usage: node eval/pick-safety.ts <project> <suite command> <source file> [more source files...] [--mutants 4]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { applyMutant, mutantsFor } from '../engine/prove/mutants.ts';
import { testFiles } from '../engine/review/coverage.ts';
import { languageOf, testsIn } from '../engine/vouch/tests-in.ts';
import { choose } from '../engine/pick/pick-command.ts';

const NL = String.fromCharCode(10);
const slash = (p: string) => p.split(String.fromCharCode(92)).join('/');

/** Which test file declares each test name, so a failure can be attributed to a file. */
function nameIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of testFiles(root)) {
    const language = languageOf(file);
    if (!language) continue;
    try {
      for (const test of testsIn(language, readFileSync(file, 'utf8'))) {
        if (!index.has(test.name)) index.set(test.name, slash(relative(root, file)));
      }
    } catch {
      // Unreadable: nothing to index.
    }
  }
  return index;
}

/** The file whose test name best ends the reported title, for runners that print the full path of a test. */
function attribute(title: string, index: Map<string, string>): string | undefined {
  let best = '';
  let file: string | undefined;
  for (const [name, where] of index) {
    if (name.length <= best.length || !title.endsWith(name)) continue;
    best = name;
    file = where;
  }
  return file;
}

/**
 * Runs the whole suite and returns the test files that failed, or null when the suite did not run at all.
 *
 * The difference matters. A mutant that stops the project building makes every test vanish, and reading
 * that as "nothing caught it" counts a broken build as evidence about a selection. That happened on the
 * first wide run, where a mutation inside a generic type broke the whole suite.
 */
function whoFailed(root: string, suite: string, index: Map<string, string>): Set<string> | null {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(suite, { cwd: root, shell: true, env, encoding: 'utf8', timeout: 900_000, maxBuffer: 128 * 1024 * 1024 });
  const failed = new Set<string>();
  const output = `${ran.stdout ?? ''}${NL}${ran.stderr ?? ''}`;
  for (const line of output.split(NL)) {
    // Two reporters, because a project's own suite command decides which one runs: TAP's `not ok`, and
    // the default reporter's cross. Reading only TAP made every mutant look uncaught, and the first run
    // of this measurement cheerfully reported that nothing could judge the selection.
    const tap = /^\s*not ok \d+\s*-?\s*(.+?)(?: # .*)?$/.exec(line);
    const spec = /^\s*[✖✘x]\s+(.+?)\s+\([\d.]+m?s\)\s*$/.exec(line);
    const name = (tap?.[1] ?? spec?.[1] ?? '').trim();
    if (!name) continue;
    // Mocha reports "suite > nested > the test name", so an exact lookup misses every time and the run
    // looked as though the project had stopped building. The longest indexed name that ends the reported
    // title is the test.
    const file = index.get(name) ?? attribute(name, index);
    if (file) failed.add(file);
  }
  if (failed.size === 0 && ran.status !== 0) {
    process.stderr.write(`    (the suite did not run at all: this change does not build)${NL}`);
    return null;
  }
  return failed;
}

interface Case {
  file: string;
  line: number;
  kind: string;
  /** Test files that caught it, by execution of the whole suite. */
  caughtBy: string[];
  /** Test files the selection chose. Empty with `everything` set means it refused to narrow. */
  selected: string[];
  everything: string;
  share: number;
}

function main(): void {
  const args = process.argv.slice(2);
  const root = resolve(args[0] ?? '.');
  const suite = args[1] ?? '';
  const limit = Number(args[args.indexOf('--mutants') + 1] ?? 4) || 4;
  const files = args.slice(2).filter((a) => !a.startsWith('--') && a !== String(limit));
  if (!suite || files.length === 0) throw new Error('usage: node eval/pick-safety.ts <project> "<suite command>" <source file> [...] [--mutants 4]');

  const index = nameIndex(root);
  process.stderr.write(`${index.size} test name(s) indexed${NL}`);

  // What is already failing. Without this, a suite that is red for an unrelated reason turns every
  // pre-existing failure into a "catcher", and the measurement reports that the selection lost a bug it
  // never had a chance to keep. That happened on the first real run, and the culprit was a stray
  // control character in this very file.
  const already = whoFailed(root, suite, index) ?? new Set<string>();
  if (already.size > 0) process.stderr.write(`${already.size} test file(s) already fail before anything is changed; they cannot judge a selection${NL}`);
  const cases: Case[] = [];

  for (const file of files) {
    const path = resolve(root, file);
    const original = readFileSync(path, 'utf8');
    const mutants = mutantsFor(original, limit);
    process.stderr.write(`${NL}${file}: ${mutants.length} mutant(s)${NL}`);
    try {
      for (const mutant of mutants) {
        writeFileSync(path, applyMutant(original, mutant), 'utf8');
        // The selection is computed from the change itself, exactly as it would be on a pull request.
        const chosen = choose({ root, diff: 'HEAD', files: [slash(file)] });
        const selected = chosen ? chosen.picked.mustRun.map((m) => slash(m.testFile)) : [];
        const everything = chosen?.picked.runEverything ?? 'the change could not be read';
        const ran = whoFailed(root, suite, index);
        if (ran === null) {
          process.stderr.write(`  line ${mutant.line}: excluded, the change does not build${NL}`);
          continue;
        }
        const caught = [...ran].filter((f) => !already.has(f));
        cases.push({ file: slash(file), line: mutant.line, kind: mutant.kind, caughtBy: caught, selected, everything, share: chosen && chosen.total > 0 ? selected.length / chosen.total : 1 });
        process.stderr.write(`  line ${mutant.line}: caught by ${caught.length} file(s), selection ${everything ? 'ran everything' : `${selected.length} file(s)`}${NL}`);
      }
    } finally {
      writeFileSync(path, original, 'utf8');
      if (readFileSync(path, 'utf8') !== original) throw new Error(`${path} was not restored`);
    }
  }

  report(cases);
}

function report(cases: Case[]): void {
  const judged = cases.filter((c) => c.caughtBy.length > 0);
  const narrowed = judged.filter((c) => !c.everything);
  const kept = narrowed.filter((c) => c.caughtBy.some((f) => c.selected.includes(f)));
  const lost = narrowed.filter((c) => !c.caughtBy.some((f) => c.selected.includes(f)));
  const refused = judged.filter((c) => c.everything);
  const share = narrowed.length > 0 ? narrowed.reduce((t, c) => t + c.share, 0) / narrowed.length : 1;
  const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

  process.stdout.write(
    [
      '# Is narrowing the test run safe?',
      '',
      `${cases.length} real change(s) made to real source files. ${judged.length} were caught by the full suite and so can judge a selection.`,
      `${cases.length - judged.length} were caught by nothing at all and are excluded: they say nothing about narrowing.`,
      '',
      '## Safety: did the narrowed run still catch it?',
      '',
      `Narrowed, and the catching test was kept:  ${kept.length} of ${narrowed.length} (${pct(kept.length, narrowed.length)})`,
      `Narrowed, and the catching test was lost:  **${lost.length}**`,
      `Refused to narrow (ran everything):        ${refused.length} of ${judged.length}`,
      '',
      '## Saving, where it did narrow',
      '',
      `Average share of the suite selected: ${(share * 100).toFixed(1)}%`,
      '',
      ...(lost.length > 0
        ? ['## Lost - a bug this would have let through', '', ...lost.map((c) => `- ${c.file}:${c.line} (${c.kind}) was caught by ${c.caughtBy.join(', ')}, none of which was selected`), '']
        : ['No change that the suite catches was lost by the selection.', '']),
      '---',
      '',
      'What this rests on: each change is a real mutation of real source, the catchers are decided by',
      'running the whole suite, and the selection is computed from the source exactly as it would be on a',
      'pull request. A mutant nothing catches is excluded rather than counted as a success, because a',
      'selection cannot keep a test that does not exist.',
      '',
    ].join(NL),
  );
}

main();
