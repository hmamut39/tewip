// The verification half of `tewip write`: a draft is kept only when it passes against the working
// app every time it is run, and fails once its main check is broken on purpose. Nothing here asks
// the model whether a test is good; it runs the test and reads the result.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LlmClient } from '../llm/client.ts';
import type { Framework } from './frameworks.ts';
import { relative } from 'node:path';
import { describeMutation, mutationTool, MUTATION_BUDGET_MS, readMutationReport, sourceUnderTest, TOO_SLOW_PER_RUN_MS } from './mutation.ts';
import { brittleChecks, draftTest, failureHead, mutate, remutate, repairTest, weakChecks as weakOf, type Draft, type Scenario, type WriteContext } from './write.ts';

export interface RunResult {
  passed: boolean;
  /** Every test was skipped: neither a pass nor a failure, since nothing was checked. */
  skipped?: boolean;
  /** The runner broke (no browser, no server, port taken) on every try: the environment, not the test. */
  environment?: boolean;
  output: string;
}

/**
 * Every test in the run was skipped (a runner exits 0 for that): nothing was checked, so it is not
 * a pass. Playwright, pytest and Jest print "1 skipped", Mocha "1 pending", Maven "Skipped: 1".
 */
export function onlySkipped(output: string): boolean {
  const karma = output.match(/Executed (\d+) of (\d+) \(skipped (\d+)\)/);
  if (karma) return karma[1] === '0';
  const maven = output.match(/Tests run: (\d+), Failures: 0, Errors: 0, Skipped: (\d+)/);
  if (maven) return maven[1] === maven[2] && maven[1] !== '0';
  return /\b[1-9]\d* (?:skipped|pending)\b/i.test(output) && !/\b[1-9]\d* pass(?:ed|ing)\b/i.test(output);
}

/** The page as it was when the test failed, when the runner saved it (Playwright's error context). */
function pageAtFailure(output: string, cwd: string): string {
  const path = output.match(/Error Context: (.+\.md)/)?.[1]?.trim();
  if (!path) return '';
  const full = isAbsolute(path) ? path : join(cwd, path);
  return existsSync(full) ? `\n\nThe page when the test failed:\n${readFileSync(full, 'utf8').slice(0, 5000)}` : '';
}

/**
 * The runner itself broke before or around the test: the browser never started, a port was taken,
 * the app's server did not come up, the run was cut off. That says nothing about the test, so the
 * run is tried again, and if it keeps breaking, the environment is named, never the test.
 */
const RUNNER_BROKE = /has not captured in \d+ ?ms|failed \d+ times \(timeout\)\. Giving up|Disconnected[, ].{0,40}because no message|No captured browser|EADDRINUSE|Timed out waiting \d+ms from config\.webServer|webServer.{0,60}(?:exited|timed out)|ENOSPC|spawnSync .* ETIMEDOUT/i;

export function runTest(framework: Framework, file: string, timeoutMs = 180_000): RunResult {
  let result = runOnce(framework, file, timeoutMs);
  for (let retry = 0; retry < 2 && !result.passed && RUNNER_BROKE.test(result.output); retry++) result = runOnce(framework, file, timeoutMs);
  if (!result.passed && RUNNER_BROKE.test(result.output)) return { ...result, environment: true };
  return result;
}

function runOnce(framework: Framework, file: string, timeoutMs: number): RunResult {
  const r = spawnSync(framework.command(file), { cwd: framework.cwd, env: { ...process.env, ...framework.env }, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  // Colour codes are noise to a reader and would stop a quoted line from matching.
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (r.status === 0 && onlySkipped(output)) return { passed: false, skipped: true, output: `The test was skipped, so nothing was checked. Make it run here.\n${output.slice(-3000)}` };
  return { passed: r.status === 0, output: output.slice(-6000) + (r.status === 0 ? '' : pageAtFailure(output, framework.cwd)) };
}

/** Above this, one run of the test is slow enough to trade a reliability run for time. */
const SLOW_RUN_MS = 90_000;

/** The broken version did not run at all, so its failure proves nothing about the check. */
const DID_NOT_RUN = /SyntaxError|error TS\d{4}|IndentationError|NameError|ReferenceError|Unexpected token|compilation (?:error|failure)|cannot find symbol|error CS\d{4}/;

export type Outcome =
  | { kind: 'kept'; runs: number; checks: string; repairs: number; mutation: string; watch: string[]; sourceCheck?: string }
  | { kind: 'possible-bug'; reason: string; repairs: number; lastError: string }
  | { kind: 'rejected'; reason: string; repairs: number; lastError?: string; passedReliably: boolean };

export interface WriteOptions {
  runs: number;
  repairs: number;
  /** Also change the code under test and check this test notices (unit frameworks, opt-in). */
  mutateSource?: boolean;
  run?: typeof runTest;
  log?: (line: string) => void;
}

export async function writeAndVerify(model: LlmClient, ctx: WriteContext, scenario: Scenario, file: string, opts: WriteOptions): Promise<{ outcome: Outcome; draft: Draft }> {
  const run = opts.run ?? runTest;
  const log = opts.log ?? (() => {});
  let draft = await draftTest(model, ctx, scenario);
  let repairs = 0;
  let result: RunResult;
  const earlier: string[] = [];
  let slowest = 0;
  for (;;) {
    writeFileSync(file, draft.code, 'utf8');
    const startedAt = Date.now();
    result = run(ctx.framework, file);
    slowest = Math.max(slowest, Date.now() - startedAt);
    if (result.passed) break;
    if (result.environment) return { draft, outcome: { kind: 'rejected', reason: 'the test runner could not start (environment: browser, server or port), so the test was not judged', repairs, lastError: result.output, passedReliably: false } };
    if (repairs >= opts.repairs) return { draft, outcome: { kind: 'rejected', reason: `still failing after ${repairs} repair(s)`, repairs, lastError: result.output, passedReliably: false } };
    repairs++;
    log(`    failed; repair ${repairs} of ${opts.repairs} from the real error`);
    const repaired = await repairTest(model, ctx, scenario, draft, result.output, earlier);
    earlier.push(failureHead(result.output));
    if (repaired.fault === 'app') {
      // The model's word is not enough: its quote must really be in what the run printed.
      // A bare label ("Received:") is in every failure and shows nothing, so the quote must say more.
      const quote = (repaired.observed ?? '').trim();
      const telling = quote.length >= 16 && quote.replace(/\b(?:Received|Expected|Error|Actual|Call log)\b|[\s:'"`.,-]/g, '').length >= 8;
      if (telling && result.output.includes(quote)) return { draft, outcome: { kind: 'possible-bug', reason: `${repaired.reason} (seen: "${quote.slice(0, 200)}")`, repairs, lastError: result.output } };
      return { draft, outcome: { kind: 'rejected', reason: `the model blamed the app but could not quote the run's output to show it, so it is not reported as a bug: ${repaired.reason.slice(0, 200)}`, repairs, lastError: result.output, passedReliably: false } };
    }
    draft = repaired;
  }

  // A runner that takes minutes per run (Angular rebuilds the app each time) gets one reliability run
  // less: the report always says how many runs a kept test passed.
  const runs = slowest > SLOW_RUN_MS ? Math.min(opts.runs, 2) : opts.runs;
  if (runs < opts.runs) log(`    each run takes about ${Math.round(slowest / 1000)}s here, so ${runs} runs instead of ${opts.runs}`);
  for (let i = 2; i <= runs; i++) {
    const again = run(ctx.framework, file);
    if (again.environment) return { draft, outcome: { kind: 'rejected', reason: `the test runner broke on run ${i} (environment: browser, server or port), so reliability was not judged`, repairs, lastError: again.output, passedReliably: false } };
    if (!again.passed) return { draft, outcome: { kind: 'rejected', reason: `flaky: passed ${i - 1} time(s), then failed on run ${i}`, repairs, lastError: again.output, passedReliably: false } };
  }
  log(`    passed ${runs} of ${runs} runs; breaking its check on purpose`);

  let mutant = mutate(draft);
  if ('problem' in mutant) {
    log(`    the deliberate break could not be applied (${mutant.problem}); asking once more`);
    draft = await remutate(model, draft, mutant.problem);
    mutant = mutate(draft);
  }
  if ('problem' in mutant) return { draft, outcome: { kind: 'rejected', reason: `could not prove it can fail: ${mutant.problem}`, repairs, passedReliably: true } };
  const runBroken = (code: string): RunResult => {
    try {
      writeFileSync(file, code, 'utf8');
      return run(ctx.framework, file);
    } finally {
      writeFileSync(file, draft.code, 'utf8');
    }
  };
  let broken = runBroken(mutant.code);
  // A break that does not compile (a type error, a syntax slip) proves nothing: ask once for another,
  // showing the compiler's complaint.
  if (!broken.passed && DID_NOT_RUN.test(broken.output)) {
    log('    the deliberate break did not compile; asking once more');
    draft = await remutate(model, draft, `the broken version did not compile or run: ${failureHead(broken.output)}`);
    const again = mutate(draft);
    if ('problem' in again) return { draft, outcome: { kind: 'rejected', reason: `could not prove it can fail: ${again.problem}`, repairs, passedReliably: true } };
    broken = runBroken(again.code);
  }
  if (broken.environment) return { draft, outcome: { kind: 'rejected', reason: 'the test runner broke while checking the deliberate break (environment), so the check was not proven', repairs, lastError: broken.output, passedReliably: true } };
  if (broken.skipped) return { draft, outcome: { kind: 'rejected', reason: 'the broken version was skipped, so the check was not proven', repairs, passedReliably: true } };
  if (broken.passed) return { draft, outcome: { kind: 'rejected', reason: `still passes with its check broken (${draft.mutation.find} → ${draft.mutation.replace}): it could not catch the bug it is for`, repairs, passedReliably: true } };
  if (DID_NOT_RUN.test(broken.output)) return { draft, outcome: { kind: 'rejected', reason: 'the broken version did not even run, so the check was not proven', repairs, lastError: broken.output, passedReliably: true } };
  const weak = weakOf(draft.code);
  const sourceCheck = opts.mutateSource ? checkAgainstSource(ctx.framework, file, draft.code, slowest, log) : undefined;
  return { draft, outcome: { kind: 'kept', runs, checks: draft.checks, repairs, mutation: `${draft.mutation.find} → ${draft.mutation.replace}`, watch: [...brittleChecks(draft.code), ...(weak ? [weak] : [])], sourceCheck } };
}

/**
 * Change the code the test covers and see whether the test notices. Every way out of this returns a
 * sentence rather than silence, because a test verified only by the cheap check must never be
 * reported as if it had passed this one.
 */
function checkAgainstSource(framework: Framework, testFile: string, testCode: string, slowestMs: number, log: (line: string) => void): string {
  const tool = mutationTool(framework);
  if (!tool) return `not checked against changes in the code: ${framework.label} runs a whole app per test, so a mutation run would take hours`;
  if ('missing' in tool) return `not checked against changes in the code: ${tool.missing}. To enable it: ${tool.install}`;
  if (slowestMs > TOO_SLOW_PER_RUN_MS) return `not checked against changes in the code: one run here takes ${Math.round(slowestMs / 1000)}s, and a mutation run needs dozens`;
  const source = sourceUnderTest(testFile, testCode, framework.cwd);
  if (!source) return 'not checked against changes in the code: could not tell which source file this test covers from its imports';
  log(`    changing ${relative(framework.cwd, source)} to see whether the test notices`);
  const r = spawnSync(tool.command(source, testFile), { cwd: framework.cwd, env: { ...process.env, ...framework.env }, shell: true, encoding: 'utf8', timeout: MUTATION_BUDGET_MS, maxBuffer: 20 * 1024 * 1024 });
  const result = readMutationReport(tool.id, framework.cwd);
  if (!result) return `not checked against changes in the code: ${tool.id} wrote no report${r.error ? ` (${r.error.message})` : ''}`;
  return describeMutation(result, source);
}
