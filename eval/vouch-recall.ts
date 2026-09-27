// Measures the recall of `tewip vouch` - the gap Phase 22 shipped with - using execution as the judge
// rather than a developer's commit message.
//
// The first attempt at this mined commit messages and failed: of 506 commits across eight phrasings,
// exactly one was a real case, and reading it showed the test already asserted something. The label was
// wrong, not the tool. So this measures the other way round, with `prove` as the independent judge.
//
// The method, and why it is not circular:
//
//  1. Take a real test file and a real source file it covers.
//  2. Make hollow tests **by a rule that knows nothing about vouch's vocabulary**: delete the last
//     statement of a test. Sometimes that removes the only check; sometimes it removes something else
//     entirely. Which of the two happened is not decided here.
//  3. Decide by **execution**, and by difference rather than absence. Mutate the source file and record
//     exactly which tests failed for each mutant, with the file whole and again with the statement
//     dropped. A test that caught mutant M when whole and no longer catches it afterwards has provably
//     lost its check: that is the label, and it needs no assumption about coverage. (The first version
//     of this counted any test that never failed as hollow, which is wrong - a test for one function
//     does not fail when another function is mutated, and it scored vouch 0 of 12 on twelve tests that
//     were all perfectly sound.)
//  4. Only then ask `vouch`, by reading, and compare.
//
// The labels come from step 3, which cannot see vouch's patterns, so a high score cannot be an artifact
// of the seeding rule. What it *is* limited by is stated in the output: "never failed across N mutants"
// is strong evidence, not proof, and a test that only notices a crash is counted apart because a
// throwing mutant does fail it.
//
// Usage: node eval/vouch-recall.ts <project> <source file> <test file> [--mutants 8] [--seed 8]
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mutantsFor, applyMutant } from '../engine/prove/mutants.ts';
import { CANNOT_FAIL, vouchFile } from '../engine/vouch/vouch.ts';
import { testsIn, languageOf } from '../engine/vouch/tests-in.ts';

const NL = String.fromCharCode(10);

/**
 * Runs the test file and reports which tests failed, keyed by **full** title.
 *
 * The plain title is not an identity: express's own file has 20 tests and only 16 distinct titles, so
 * keying by title silently merged four of them and the first run of this measurement was nonsense.
 */
function run(root: string, testFile: string): { failed: Set<string>; all: Map<string, string> } {
  return usesMocha(root) ? viaMocha(root, testFile) : viaNode(root, testFile);
}

const usesMocha = (root: string): boolean => {
  try {
    return /"mocha"\s*:/.test(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
};

function viaMocha(root: string, testFile: string): { failed: Set<string>; all: Map<string, string> } {
  const ran = spawnSync('npx', ['mocha', testFile, '--reporter', 'json'], { cwd: root, shell: true, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  const out = ran.stdout ?? '';
  const start = out.indexOf('{');
  try {
    const report = JSON.parse(out.slice(start)) as { tests: Array<{ title: string; fullTitle: string }>; failures: Array<{ fullTitle: string }> };
    return { failed: new Set(report.failures.map((f) => f.fullTitle)), all: new Map(report.tests.map((t) => [t.fullTitle, t.title])) };
  } catch {
    return { failed: new Set(), all: new Map() };
  }
}

/**
 * Node's own runner, read from its TAP output. A second runner is not a luxury: a recall figure from one
 * project's test file is an anecdote, and this makes any repository using `node --test` - including this
 * one, with its 659 tests - part of the corpus.
 */
function viaNode(root: string, testFile: string): { failed: Set<string>; all: Map<string, string> } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], { cwd: root, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const all = new Map<string, string>();
  const failed = new Set<string>();
  for (const line of `${ran.stdout ?? ''}`.split(NL)) {
    // Only the leaves: a `describe` reports as an unindented ok/not ok of its own, and counting it
    // would attribute a failure to every test inside it.
    const hit = /^(\s+)(not )?ok \d+ - (.+?)(?: # .*)?$/.exec(line);
    if (!hit) continue;
    const name = hit[3].trim();
    all.set(name, name);
    if (hit[2]) failed.add(name);
  }
  return { failed, all };
}

/**
 * Hollow tests made by a rule that knows nothing about assertions: drop the last statement of a test.
 * Whether that removed the check is not decided here - execution decides it later.
 */
function withLastStatementDropped(text: string, only: string[]): { text: string; touched: string[] } {
  const language = languageOf('x.js')!;
  const tests = testsIn(language, text);
  const lines = text.split(NL);
  const touched: string[] = [];
  // Spread over the file, and from the bottom up so earlier line numbers stay valid.
  // Only the tests that were *proved* to check something: removing their last statement is the only
  // deletion that reliably creates a hollow test, and anything else muddies the label.
  const chosen = tests.filter((t) => only.includes(t.name) && t.body.trim().split(NL).length >= 2).reverse();
  for (const test of chosen) {
    const body = test.body.split(NL);
    let last = -1;
    for (let i = body.length - 1; i >= 0; i -= 1) {
      const line = body[i].trim();
      if (line !== '' && line !== '}' && line !== '})' && line !== '});' && !line.startsWith('//')) {
        last = i;
        break;
      }
    }
    if (last === -1) continue;
    // Only a line that is a statement on its own. Blanking the closing line of a multi-line call, or a
    // line of a TypeScript type, breaks the file - and a broken file makes every test look as though it
    // had lost its check, which is a measurement that reports whatever it was asked to report.
    if (!selfContained(body[last])) continue;
    // `test.line` is 1-based and its body begins on that same line, so the array index is one less.
    // Getting this wrong deleted the closing bracket of each test instead of its last statement, the
    // file stopped parsing, mocha ran nothing, and every test looked as though it had lost its check -
    // a measurement that would have reported whatever it was asked to report.
    const at = test.line - 1 + last;
    if (!lines[at]) continue;
    const kept = lines[at];
    lines[at] = '';
    if (!parses(lines.join(NL))) {
      lines[at] = kept; // this deletion would have broken the file, so it is not a fair seeding
      continue;
    }
    touched.push(test.name);
  }
  return { text: lines.join(NL), touched };
}

export type Says = 'cannot-fail' | 'crash-only' | 'checks' | 'not-judged' | 'not-found';

/** A line that stands alone: its brackets balance and it ends a statement. */
function selfContained(line: string): boolean {
  const text = line.trim();
  if (!/[;)\]}]$/.test(text) || text.startsWith('}') || text.startsWith(')')) return false;
  let depth = 0;
  for (const ch of text) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Does this still parse? A deletion that breaks the file teaches nothing about reading tests. */
function parses(text: string): boolean {
  const tmp = join(tmpdir(), `tewip-seed-${process.pid}.js`);
  writeFileSync(tmp, text, 'utf8');
  try {
    return spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 20_000 }).status === 0;
  } finally {
    rmSync(tmp, { force: true });
  }
}

interface Judged {
  /** The `it(...)` title, which is what vouch knows a test by. */
  name: string;
  /** Describe blocks plus title: the only thing that identifies a test uniquely. */
  full: string;
  /** The mutants this test failed for, by line and kind. */
  caught: Set<string>;
  /** What vouch says about it, by reading. */
  says: Says;
}

function judge(root: string, sourceFile: string, testFile: string, mutantCount: number): Judged[] {
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, 'utf8');
  const mutants = mutantsFor(original, mutantCount);
  process.stderr.write(`${mutants.length} mutant(s) of ${sourceFile}${NL}`);

  const base = run(root, testFile);
  process.stderr.write(`${base.all.size} test(s) ran before anything was changed${NL}`);
  const caught = new Map<string, Set<string>>();
  for (const full of base.all.keys()) caught.set(full, new Set());
  try {
    for (const mutant of mutants) {
      const key = `${mutant.line}:${mutant.kind}`;
      writeFileSync(sourcePath, applyMutant(original, mutant), 'utf8');
      const result = run(root, testFile);
      for (const name of result.failed) caught.set(name, (caught.get(name) ?? new Set()).add(key));
      process.stderr.write(`  line ${mutant.line} ${mutant.kind}: ${result.failed.size} test(s) failed${NL}`);
    }
  } finally {
    writeFileSync(sourcePath, original, 'utf8');
    if (readFileSync(sourcePath, 'utf8') !== original) throw new Error(`${sourcePath} was not restored`);
  }

  const read = vouchFile(testFile, readFileSync(resolve(root, testFile), 'utf8'));
  return [...base.all.entries()].map(([full, name]) => {
    const judgement = read.judgements.find((j) => j.name === name);
    const says: Says = !judgement
      ? 'not-found'
      : CANNOT_FAIL.includes(judgement.verdict)
        ? 'cannot-fail'
        : judgement.verdict === 'crash-only'
          ? 'crash-only'
          : judgement.verdict === 'cannot-tell'
            ? 'not-judged'
            : 'checks';
    return { name, full, caught: caught.get(full) ?? new Set<string>(), says };
  });
}

function main(): void {
  const [root, sourceFile, testFile] = process.argv.slice(2);
  const args = process.argv.slice(2);
  const number = (name: string, fallback: number) => Number(args[args.indexOf(`--${name}`) + 1] ?? fallback) || fallback;
  if (!root || !sourceFile || !testFile) throw new Error('usage: node eval/vouch-recall.ts <project> <source file> <test file> [--mutants 8] [--seed 8]');

  const testPath = resolve(root, testFile);
  const originalTests = readFileSync(testPath, 'utf8');
  let hollowed: string[] = [];
  try {
    // First the file as its authors wrote it, then the same file with some checks removed by the
    // vocabulary-free rule, so the corpus holds both kinds.
    const asWritten = judge(root, sourceFile, testFile, number('mutants', 8));
    const proved = asWritten.filter((j) => j.caught.size > 0).map((j) => j.name);
    process.stderr.write(`${NL}${proved.length} test(s) proved they check something; removing their last statement${NL}`);
    const seeded = withLastStatementDropped(originalTests, proved);
    hollowed = seeded.touched;
    writeFileSync(testPath, seeded.text, 'utf8');
    process.stderr.write(`${NL}last statement dropped from ${hollowed.length} test(s)${NL}`);
    const afterSeeding = judge(root, sourceFile, testFile, number('mutants', 8));
    // The seeded file has to run the same tests. If it does not, the deletion broke something and every
    // comparison below would be an artifact rather than a finding.
    if (afterSeeding.length !== asWritten.length) {
      throw new Error(`the seeded file ran ${afterSeeding.length} test(s) where the original ran ${asWritten.length}, so the deletion broke it and nothing is reported`);
    }
    report(asWritten, afterSeeding, hollowed);
  } finally {
    writeFileSync(testPath, originalTests, 'utf8');
    if (readFileSync(testPath, 'utf8') !== originalTests) throw new Error(`${testPath} was not restored`);
  }
}

function report(asWritten: Judged[], afterSeeding: Judged[], hollowed: string[]): void {
  const before = new Map(asWritten.map((j) => [j.full, j]));

  // The sound label: this test caught something when whole, and catches nothing now. Its check is gone,
  // by execution, with no assumption about what covers what.
  const lostItsCheck = afterSeeding.filter((j) => {
    const whole = before.get(j.full);
    return hollowed.includes(j.name) && whole !== undefined && whole.caught.size > 0 && j.caught.size === 0;
  });
  // Seeded tests that still catch something: the deletion removed something other than the check, so
  // they are not hollow - and vouch must not accuse them.
  const stillSound = afterSeeding.filter((j) => j.caught.size > 0);

  const named = lostItsCheck.filter((j) => j.says === 'cannot-fail' || j.says === 'crash-only');
  const outright = lostItsCheck.filter((j) => j.says === 'cannot-fail');
  const missed = lostItsCheck.filter((j) => j.says === 'checks');
  const accused = stillSound.filter((j) => j.says === 'cannot-fail');
  const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

  process.stdout.write(
    [
      '# vouch, judged by execution',
      '',
      `${asWritten.length} test(s) in the file. The last statement was dropped from ${hollowed.length}.`,
      `**${lostItsCheck.length}** of those provably lost their check: each caught a mutation of the source before, and catches none now.`,
      '',
      '## Recall: of the tests that provably lost their check, how many does vouch name?',
      '',
      `Named at all (cannot fail, or compares no value): ${named.length} of ${lostItsCheck.length} (${pct(named.length, lostItsCheck.length)})`,
      `Named as unable to fail outright:                 ${outright.length} of ${lostItsCheck.length} (${pct(outright.length, lostItsCheck.length)})`,
      `Missed - vouch called them sound:                 ${missed.length}`,
      `Refused to judge:                                ${lostItsCheck.filter((j) => j.says === 'not-judged').length}`,
      '',
      '## Precision: does it accuse a test that still catches things?',
      '',
      `Tests that still caught a mutation after the deletion: ${stillSound.length}`,
      `Of those, wrongly called unable to fail:               ${accused.length}`,
      '',
      ...(missed.length > 0 ? ['## The ones it missed', '', ...missed.slice(0, 15).map((j) => `- ${j.name}`), ''] : []),
      ...(accused.length > 0 ? ['## Wrongly accused', '', ...accused.slice(0, 10).map((j) => `- ${j.name}`), ''] : []),
      '---',
      '',
      'What the labels rest on: a test counted as having lost its check is one that failed for at least',
      'one mutation of the source before the deletion and for none afterwards. That is execution, not',
      "reading, and the deletion rule knows nothing about vouch's vocabulary - which is what stops this",
      'being a measurement of its own seeding. It is still a floor rather than an estimate: the mutants',
      'are few, and a test whose check survives in a form no mutant here reaches is simply not counted.',
      '',
    ].join(NL),
  );
}

main();
