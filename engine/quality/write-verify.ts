// The verification half of `tewip write`: a draft is kept only when it passes against the working
// app every time it is run, and fails once its main check is broken on purpose. Nothing here asks
// the model whether a test is good; it runs the test and reads the result.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LlmClient } from '../llm/client.ts';
import type { Framework } from './frameworks.ts';
import { draftTest, mutate, repairTest, type Draft, type Scenario, type WriteContext } from './write.ts';

export interface RunResult {
  passed: boolean;
  /** Every test was skipped: neither a pass nor a failure, since nothing was checked. */
  skipped?: boolean;
  output: string;
}

/**
 * Every test in the run was skipped (a runner exits 0 for that): nothing was checked, so it is not
 * a pass. Playwright, pytest and Jest print "1 skipped", Mocha "1 pending", Maven "Skipped: 1".
 */
export function onlySkipped(output: string): boolean {
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

export function runTest(framework: Framework, file: string, timeoutMs = 180_000): RunResult {
  const r = spawnSync(framework.command(file), { cwd: framework.cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
  if (r.status === 0 && onlySkipped(output)) return { passed: false, skipped: true, output: `The test was skipped, so nothing was checked. Make it run here.\n${output.slice(-3000)}` };
  return { passed: r.status === 0, output: output.slice(-6000) + (r.status === 0 ? '' : pageAtFailure(output, framework.cwd)) };
}

/** The broken version did not run at all, so its failure proves nothing about the check. */
const DID_NOT_RUN = /SyntaxError|error TS\d{4}|IndentationError|NameError|ReferenceError|Unexpected token|compilation (?:error|failure)|cannot find symbol|error CS\d{4}/;

export type Outcome =
  | { kind: 'kept'; runs: number; checks: string; repairs: number; mutation: string }
  | { kind: 'possible-bug'; reason: string; repairs: number; lastError: string }
  | { kind: 'rejected'; reason: string; repairs: number; lastError?: string; passedReliably: boolean };

export interface WriteOptions {
  runs: number;
  repairs: number;
  run?: typeof runTest;
  log?: (line: string) => void;
}

export async function writeAndVerify(model: LlmClient, ctx: WriteContext, scenario: Scenario, file: string, opts: WriteOptions): Promise<{ outcome: Outcome; draft: Draft }> {
  const run = opts.run ?? runTest;
  const log = opts.log ?? (() => {});
  let draft = await draftTest(model, ctx, scenario);
  let repairs = 0;
  let result: RunResult;
  for (;;) {
    writeFileSync(file, draft.code, 'utf8');
    result = run(ctx.framework, file);
    if (result.passed) break;
    if (repairs >= opts.repairs) return { draft, outcome: { kind: 'rejected', reason: `still failing after ${repairs} repair(s)`, repairs, lastError: result.output, passedReliably: false } };
    repairs++;
    log(`    failed; repair ${repairs} of ${opts.repairs} from the real error`);
    const repaired = await repairTest(model, ctx, scenario, draft, result.output);
    if (repaired.fault === 'app') return { draft, outcome: { kind: 'possible-bug', reason: repaired.reason, repairs, lastError: result.output } };
    draft = repaired;
  }

  for (let i = 2; i <= opts.runs; i++) {
    const again = run(ctx.framework, file);
    if (!again.passed) return { draft, outcome: { kind: 'rejected', reason: `flaky: passed ${i - 1} time(s), then failed on run ${i}`, repairs, lastError: again.output, passedReliably: false } };
  }
  log(`    passed ${opts.runs} of ${opts.runs} runs; breaking its check on purpose`);

  const mutant = mutate(draft);
  if ('problem' in mutant) return { draft, outcome: { kind: 'rejected', reason: `could not prove it can fail: ${mutant.problem}`, repairs, passedReliably: true } };
  let broken: RunResult;
  try {
    writeFileSync(file, mutant.code, 'utf8');
    broken = run(ctx.framework, file);
  } finally {
    writeFileSync(file, draft.code, 'utf8');
  }
  if (broken.skipped) return { draft, outcome: { kind: 'rejected', reason: 'the broken version was skipped, so the check was not proven', repairs, passedReliably: true } };
  if (broken.passed) return { draft, outcome: { kind: 'rejected', reason: `still passes with its check broken (${draft.mutation.find} → ${draft.mutation.replace}): it could not catch the bug it is for`, repairs, passedReliably: true } };
  if (DID_NOT_RUN.test(broken.output)) return { draft, outcome: { kind: 'rejected', reason: 'the broken version did not even run, so the check was not proven', repairs, lastError: broken.output, passedReliably: true } };
  return { draft, outcome: { kind: 'kept', runs: opts.runs, checks: draft.checks, repairs, mutation: `${draft.mutation.find} → ${draft.mutation.replace}` } };
}
