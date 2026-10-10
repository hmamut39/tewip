// GitHub Action "pick" mode (see action.yml): narrow the test run before it starts.
//
// This is the only mode that runs *before* the tests, because that is the only place a selection can
// save anything. It writes two step outputs - the files to run, and whether it narrowed at all - so the
// workflow decides what to do with them:
//
//   - id: pick
//     uses: hmamut39/tewip@main
//     with: { mode: pick }
//   - run: npx jest ${{ steps.pick.outputs.tests }}
//
// The audit matters as much as the saving. Whatever is left out is written into the job summary with the
// reason beside it, so "why did CI not run that test" has an answer in the run itself rather than in
// somebody's memory. And when it cannot narrow safely, `narrowed` is false and `tests` is empty: a
// workflow that uses the outputs without checking still runs its whole suite, which is the safe default.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choose } from '../engine/pick/pick-command.ts';
import { renderPick } from '../engine/pick/pick.ts';
import { readCiContext } from './context.ts';

const NL = String.fromCharCode(10);

function main(): void {
  const ctx = readCiContext();
  mkdirSync(ctx.outDir, { recursive: true });

  // On a pull request, against its base. On a branch, against the default branch. Both ranges are tried
  // as the runner may or may not have the base fetched; a shallow checkout has neither, and then nothing
  // is claimed.
  const base = ctx.pr?.baseRef ?? ctx.defaultBranch;
  const chosen = [`origin/${base}...HEAD`, `${base}...HEAD`].map((range) => ({ range, result: choose({ root: ctx.workspace, diff: range }) })).find((a) => a.result !== null);

  if (!chosen?.result) {
    say(ctx, 'Tewip could not read what this change touched, so the whole suite should run. Set `fetch-depth: 0` on actions/checkout to let it narrow.');
    output(ctx, { tests: '', narrowed: 'false' });
    return;
  }

  const { picked, total, command, noHistory } = chosen.result;
  const report = renderPick(picked, total, command, noHistory);
  writeFileSync(join(ctx.outDir, 'picked.md'), `${report}${NL}`, 'utf8');

  if (picked.runEverything) {
    console.log(`[tewip] running everything: ${picked.runEverything}`);
    say(ctx, report);
    output(ctx, { tests: '', narrowed: 'false' });
    return;
  }

  const files = picked.mustRun.map((m) => m.testFile);
  console.log(`[tewip] ${files.length} of ${total} test file(s) could notice this change`);
  say(ctx, report);
  output(ctx, { tests: files.join(' '), narrowed: 'true' });
}

/** The job summary: the selection, and everything it left out, so the run carries its own audit. */
function say(ctx: { stepSummary: string | null }, body: string): void {
  if (!ctx.stepSummary) return;
  appendFileSync(ctx.stepSummary, `${body.slice(0, 900_000)}${NL}${NL}`, 'utf8');
}

function output(ctx: { outputFile: string | null }, values: Record<string, string>): void {
  if (!ctx.outputFile) {
    for (const [name, value] of Object.entries(values)) console.log(`${name}=${value}`);
    return;
  }
  for (const [name, value] of Object.entries(values)) appendFileSync(ctx.outputFile, `${name}=${value}${NL}`, 'utf8');
}

main();
