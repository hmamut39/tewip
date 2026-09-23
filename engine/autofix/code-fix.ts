// Phase 12: ACT + VERIFY for a change to application code. This is the one place where Tewip may
// edit code that is not a test, and it stays safe only under the rule the roadmap sets, which is
// enforced here rather than promised: the failing test is the oracle.
//
// A change is offered only when all of this is shown, in this order:
//   1. the failure was diagnosed a real bug with high confidence, and a person asked for --code;
//   2. the file is the project's own source, named by the stack, and not a test or configuration;
//   3. the test really fails before the change (otherwise there is nothing to fix);
//   4. the change is small and local, and applies exactly once;
//   5. the same test passes after it;
//   6. the rest of the suite still passes - no green bought by breaking something else.
// If any step cannot be shown, the file goes back exactly as it was and Tewip explains the bug
// instead. An explanation with evidence is what the developer wanted anyway.
import { relative, resolve, sep } from 'node:path';
import type { LlmClient } from '../llm/client.ts';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { PlannedAction } from '../decide.ts';
import { codeTarget, mayChange } from './code-target.ts';
import { excerpt, proposeCodeFix, type CodeChange } from './code-propose.ts';
import { countChanged, lineDiff, renderDiff } from './line-diff.ts';

/**
 * The runner never ran the test: a missing module, a reporter or config it could not load, a
 * browser that never started. The test did not fail - it never happened - so a change afterwards
 * would be proved by nothing. Tewip stops and says what has to be fixed first. (This was found by
 * running the fixer against real bug fixes with a mistyped runner flag: every case looked like a
 * failing test, and every fix looked like it did not work.)
 */
const NEVER_RAN = /No test files found|Failed to load url|Cannot find module|ModuleNotFoundError|ImportError while importing test module|ERR_MODULE_NOT_FOUND|has not captured in \d+ ?ms|No captured browser|EADDRINUSE|webServer.{0,60}(?:exited|timed out)|command not found|is not recognized as an internal/i;

/** More changed lines than this is a rewrite, not a bug fix, whatever the model calls it. */
export const MAX_CHANGED_LINES = 20;
/** How many times the model may try before Tewip gives up and explains instead. */
export const MAX_ATTEMPTS = 3;

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);

export type CodeFixStatus =
  | 'fixed'
  | 'not-eligible'
  | 'no-target'
  | 'outside-project'
  | 'test-does-not-fail'
  | 'test-never-ran'
  | 'model-declined'
  | 'change-not-found'
  | 'change-too-large'
  | 'still-failing'
  | 'broke-others';

export interface CodeFixResult {
  testId: string;
  status: CodeFixStatus;
  /** True only while a proved change is in the file; a suggestion run puts the file back. */
  applied: boolean;
  file?: string;
  why?: string;
  before?: string;
  after?: string;
  /** The unified diff a reviewer reads, and a pull request carries. */
  diff?: string;
  attempts: Array<{ file: string; changedLines: number; detail: string }>;
  log: string[];
}

export interface CodeFixDeps {
  /** The project. Nothing outside it is ever read or written. */
  root: string;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  /** Runs the one failing test. */
  runTest(): Promise<{ passed: boolean; output: string }>;
  /** Runs the rest of the suite: everything except the test above. */
  runSuite(): Promise<{ passed: boolean; output: string }>;
  model: LlmClient;
}

export interface CodeFixInput {
  record: TriageRecord;
  diagnosis: Diagnosis;
  action: PlannedAction;
  /** The failing test's source, so the model can see what the code is being asked for. */
  testSource: string;
  /** Where that test lives: when nothing threw in the code, its imports say what to look at. */
  testFile?: string;
}

/**
 * Which other tests a change broke, by name. A tail of runner output is mostly noise; the names of
 * the tests that used to pass say what behaviour the fix must keep, and that is what the next
 * attempt needs to hear.
 */
export function failingTests(output: string): string[] {
  const names = [
    ...output.matchAll(/^(?:FAILED|ERROR)\s+(\S+)/gm), // pytest
    ...output.matchAll(/^\s*(?:FAIL|×)\s+(.+?)(?:\s+\d+\s*ms)?$/gm), // vitest, jest
    ...output.matchAll(/^\s*\d+\)\s+(.+)$/gm), // mocha
    ...output.matchAll(/^\s*\[FAIL\]\s+(.+)$/gm), // .NET
  ]
    .map((m) => m[1].trim())
    .filter((name) => name.length > 0 && !/^\d+$/.test(name));
  return [...new Set(names)];
}

/** Those names, said in one line for the model to read. */
export function brokeWhat(names: string[], fallback: string, max = 8): string {
  if (names.length === 0) return fallback.slice(-400);
  return `${names.slice(0, max).join(', ')}${names.length > max ? `, and ${names.length - max} more` : ''}`;
}

/** The patch a reviewer reads: real hunks, not the whole span between the first and last change. */
export function changeDiff(file: string, original: string, changed: string): string {
  return renderDiff(file, lineDiff(original, changed));
}

/** How many lines a change really adds or removes, counted from that same diff. */
export function changedLines(original: string, changed: string): number {
  return countChanged(lineDiff(original, changed));
}

export async function attemptCodeFix(input: CodeFixInput, deps: CodeFixDeps, { keep = false }: { keep?: boolean } = {}): Promise<CodeFixResult> {
  const { record, diagnosis, action } = input;
  const result: CodeFixResult = { testId: record.testId, status: 'not-eligible', applied: false, attempts: [], log: [] };
  const stop = (status: CodeFixStatus, why: string): CodeFixResult => ({ ...result, status, why, log: [...result.log, why] });

  // 1. A real bug, said with confidence, and a person asked for this.
  if (diagnosis.category !== 'REAL_BUG' || action.kind !== 'file-bug') {
    return stop('not-eligible', `only a failure diagnosed as a real bug is fixed in code; this one is ${diagnosis.category} (${action.kind})`);
  }
  if (diagnosis.confidence < 0.85) return stop('not-eligible', `the diagnosis is only ${diagnosis.confidence.toFixed(2)} confident, and code is not changed on a guess`);

  // 2. A file the failure names, that Tewip is allowed to change.
  const stack = [record.errorStack, record.errorMessage].join('\n');
  const test = input.testFile ? { file: input.testFile, source: input.testSource } : undefined;
  const { target, why, more } = codeTarget(stack, deps.root, test, `${record.testId} ${record.errorMessage}`);
  if (!target) return stop('no-target', why);
  const rel = relative(resolve(deps.root), target.file);
  if (rel.startsWith('..') || rel.startsWith(sep)) return stop('outside-project', `${target.file} is outside ${deps.root}`);
  const allowed = mayChange(target.file);
  if (!allowed.allowed) return stop('outside-project', `refused to change ${rel}: ${allowed.why}`);
  result.file = rel;
  result.log.push(target.why);

  // 3. The test must really fail first, or a pass afterwards proves nothing.
  const before = await deps.runTest();
  if (before.passed) return stop('test-does-not-fail', 'the test passes as the code is now, so there is nothing to fix here');
  if (NEVER_RAN.test(before.output)) {
    const said = before.output.split('\n').find((l) => NEVER_RAN.test(l));
    return stop('test-never-ran', `the test never ran, so nothing can be proved here: ${said?.trim().slice(0, 200)}`);
  }
  result.log.push('the test fails before any change, as expected');

  // What is already broken here, before Tewip touches anything. Real projects have failing and
  // skipped tests of their own, and a repository checked out at an older commit has more; blaming a
  // fix for those would reject every correct change, which is exactly what happened in a measurement
  // before this existed. The suite is read once, lazily, and only to know what NOT to blame.
  let baseline: Set<string> | null = null;
  const alreadyFailing = async (): Promise<Set<string>> => {
    if (!baseline) {
      const run = await deps.runSuite();
      baseline = new Set(run.passed ? [] : failingTests(run.output));
      if (baseline.size > 0) result.log.push(`${baseline.size} test(s) in this project were already failing before any change, and are not counted against the fix`);
    }
    return baseline;
  };

  // The bug is not always in the first file that looked right. When the model says the cause is not
  // in the file it was given, the next candidate is tried rather than the whole attempt abandoned.
  let last = stop('no-target', why || 'nothing to change');
  const trail: string[] = [];
  for (const candidate of [target, ...more]) {
    const outcome = await tryFile(candidate, input, deps, { keep, alreadyFailing, result: { ...result, file: relative(resolve(deps.root), candidate.file) } });
    if (outcome.status === 'fixed') return { ...outcome, log: [...trail, ...outcome.log] };
    trail.push(`${relative(resolve(deps.root), candidate.file)}: ${outcome.status}`);
    last = { ...outcome, log: [...trail, ...outcome.log] };
    if (outcome.status !== 'model-declined' && outcome.status !== 'change-not-found') break;
    if (more.length > 0) last.log.push(`the cause was not in ${relative(resolve(deps.root), candidate.file)}, so the next file the test is about was tried`);
  }
  return last;
}

/** One file: ask, check the change is small and exact, apply, run the test, run the suite. */
async function tryFile(
  target: { file: string; line: number; why: string },
  input: CodeFixInput,
  deps: CodeFixDeps,
  { keep, result, alreadyFailing }: { keep: boolean; result: CodeFixResult; alreadyFailing: () => Promise<Set<string>> },
): Promise<CodeFixResult> {
  const { record } = input;
  const rel = relative(resolve(deps.root), target.file);
  const stop = (status: CodeFixStatus, why: string): CodeFixResult => ({ ...result, status, why, log: [...result.log, why] });
  // A checkout on Windows has CRLF line endings; a model answers in LF. Comparing them directly
  // threw away four correct fixes in a real measurement, so both sides are read in LF here and the
  // file is written back in whatever it used.
  const raw = deps.readFile(target.file);
  const crlf = raw.includes(CR + NL);
  const asFile = (text: string) => (crlf ? text.split(NL).join(CR + NL) : text);
  const original = crlf ? raw.split(CR + NL).join(NL) : raw;
  const piece = excerpt(original, target.line);
  const earlier: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let change: CodeChange;
    try {
      change = await proposeCodeFix(deps.model, {
        testId: record.testId,
        error: `${record.errorMessage}\n${record.errorStack}`.slice(0, 4000),
        testSource: input.testSource.slice(0, 8000),
        file: rel,
        source: piece.text,
        line: target.line,
        earlier,
      });
    } catch (error) {
      return stop('model-declined', `the model could not answer: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (change.fault === 'test' || !change.before.trim()) {
      return stop('model-declined', `no code change offered: ${change.why || 'the cause is not visible in this file'}`);
    }
    const before = change.before.split(CR + NL).join(NL);
    const after = change.after.split(CR + NL).join(NL);
    const occurrences = original.split(before).length - 1;
    if (occurrences !== 1) {
      earlier.push(`attempt ${attempt}: the text to replace ${occurrences === 0 ? 'was not in the file' : `appeared ${occurrences} times`}`);
      result.attempts.push({ file: rel, changedLines: 0, detail: earlier.at(-1)! });
      if (attempt === MAX_ATTEMPTS) return stop('change-not-found', `the proposed change does not match the file exactly (${earlier.at(-1)})`);
      continue;
    }

    const changed = original.replace(before, after);
    const touched = changedLines(original, changed);
    if (touched > MAX_CHANGED_LINES) {
      earlier.push(`attempt ${attempt}: the change touched ${touched} lines, which is a rewrite rather than a fix`);
      result.attempts.push({ file: rel, changedLines: touched, detail: earlier.at(-1)! });
      if (attempt === MAX_ATTEMPTS) return stop('change-too-large', earlier.at(-1)!);
      continue;
    }

    // 5 and 6. The test, then everything else. The file goes back unless both hold.
    deps.writeFile(target.file, asFile(changed));
    try {
      const after = await deps.runTest();
      if (!after.passed) {
        earlier.push(`attempt ${attempt}: the test still failed after the change: ${after.output.slice(-400)}`);
        result.attempts.push({ file: rel, changedLines: touched, detail: 'the test still failed' });
        deps.writeFile(target.file, raw);
        if (attempt === MAX_ATTEMPTS) return stop('still-failing', 'the test still failed after every change tried, so the file was put back');
        continue;
      }
      const suite = await deps.runSuite();
      // A change is rejected for what it broke, not for what was broken before it.
      const failingNow = failingTests(suite.output);
      const wasFailing = suite.passed ? new Set<string>() : await alreadyFailing();
      const brokeNow = failingNow.filter((name) => !wasFailing.has(name));
      if (!suite.passed && (brokeNow.length > 0 || failingNow.length === 0)) {
        earlier.push(`attempt ${attempt}: the failing test passed, but this change broke tests that were passing: ${brokeWhat(brokeNow, suite.output)}. Those describe behaviour the code must keep. Fix the reported bug without changing what they rely on.`);
        result.attempts.push({ file: rel, changedLines: touched, detail: 'other tests broke' });
        deps.writeFile(target.file, raw);
        if (attempt === MAX_ATTEMPTS) return stop('broke-others', 'the change made this test pass by breaking others, so the file was put back');
        continue;
      }
      result.attempts.push({ file: rel, changedLines: touched, detail: 'the test passes and the rest of the suite still passes' });
      result.log.push(`the test passes with the change, and the rest of the suite still passes (${touched} line(s) changed in ${rel})`);
      const diff = changeDiff(rel, original, changed);
      if (!keep) deps.writeFile(target.file, raw);
      return { ...result, status: 'fixed', applied: keep, before: change.before, after: change.after, why: change.why, diff };
    } catch (error) {
      deps.writeFile(target.file, raw);
      throw error;
    }
  }
  return stop('still-failing', 'no change could be proved');
}
