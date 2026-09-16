// Auto-fix in CI (Phase 5): repair agent-eligible drifted locators in the workspace, verify each
// by re-running its test, then commit only the verified changes to a separate branch built from
// the PR's own head and open a pull request for a human to review. Never merges.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { attemptFix, fixDiff, type FixResult } from '../engine/autofix/autofix.ts';
import { readPageSnapshot } from '../engine/snapshot.ts';
import type { TriageItem } from '../outlets/items.ts';
import { clean } from '../outlets/view.ts';
import type { TriageRecord } from '../reporters/types.ts';
import type { CiContext } from './context.ts';
import type { GitHub, IssueRef } from './github.ts';

const BOT_NAME = 'triage-agent[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.stdout).slice(0, 300)}`);
  return run.stdout;
}

/** VERIFY: re-run one test with the project's own command; true only if it ran and passed. */
function verifier(ctx: CiContext) {
  const [cmd, ...cmdArgs] = ctx.verifyCommand.split(/\s+/).filter(Boolean);
  return async (specFile: string, title: string) => {
    const grep = `${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const spec = relative(ctx.workspace, specFile).split(sep).join('/');
    const run = spawnSync(cmd, [...cmdArgs, spec, '-g', grep, '--reporter=json'], { cwd: ctx.workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try {
      const json = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'), run.stdout.lastIndexOf('}') + 1)) as { stats: { expected: number; unexpected: number } };
      return { passed: json.stats.expected >= 1 && json.stats.unexpected === 0, detail: `${json.stats.expected} passed, ${json.stats.unexpected} failed` };
    } catch {
      return { passed: false, detail: `could not read the test result (exit ${run.status})` };
    }
  };
}

/** Re-applies an accepted fix to the same file on another checkout: the occurrence nearest the original line. */
function applyFix(file: string, fix: FixResult): boolean {
  if (!existsSync(file) || !fix.original || !fix.replacement) return false;
  const source = readFileSync(file, 'utf8');
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let at = source.indexOf(fix.original); at >= 0; at = source.indexOf(fix.original, at + 1)) {
    const distance = Math.abs(source.slice(0, at).split('\n').length - (fix.line ?? 0));
    if (distance < bestDistance) [best, bestDistance] = [at, distance];
  }
  if (best < 0) return false;
  writeFileSync(file, source.slice(0, best) + fix.replacement + source.slice(best + fix.original.length), 'utf8');
  return true;
}

function prBody(ctx: CiContext, accepted: Array<{ fix: FixResult; item: TriageItem }>): string {
  return [
    `triage-agent found ${accepted.length} test(s) whose locator no longer matches a renamed element, rewrote each locator, and re-ran each test: all passed.`,
    '',
    '**Please review before merging.** An intended UI change and a regression can look alike; check that each new locator targets the element the test meant. Only test code changed.',
    '',
    ...accepted.flatMap(({ fix, item }) => [
      `### ${clean(item.title)}`,
      `Diagnosis: ${item.diagnosis.category}, confidence ${item.diagnosis.confidence.toFixed(2)}, source: ${clean(item.source)}`,
      '',
      '```diff',
      fixDiff(fix, relative(ctx.workspace, fix.specFile).split(sep).join('/')),
      '```',
      ...fix.log.map((line) => `- ${clean(line)}`),
      '',
    ]),
    `<sub>Triggered by [run ${ctx.runId}](${ctx.runUrl}) on \`${ctx.sha.slice(0, 8)}\`${ctx.pr ? ` (PR #${ctx.pr.number})` : ''}.</sub>`,
  ].join('\n');
}

export async function autofixAndOpenPr(
  ctx: CiContext,
  github: GitHub,
  items: TriageItem[],
  records: TriageRecord[],
): Promise<{ fixes: FixResult[]; pr: IssueRef | null }> {
  const eligible = items.filter((i) => i.action.kind === 'fix-locator' && i.action.autonomous);
  const fixes: FixResult[] = [];
  const accepted: Array<{ fix: FixResult; item: TriageItem }> = [];
  for (const item of eligible) {
    const record = records.find((r) => r.runId === item.runId && r.testId === item.testId);
    if (!record) continue;
    const fix = await attemptFix(
      { record, diagnosis: item.diagnosis, action: item.action, specFile: join(ctx.workspace, record.file) },
      {
        allowedRoot: join(ctx.workspace, ctx.testsDir),
        readFile: (p) => readFileSync(p, 'utf8'),
        writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
        verify: verifier(ctx),
        loadSnapshot: readPageSnapshot,
      },
    );
    fixes.push(fix);
    if (fix.status === 'fixed') accepted.push({ fix, item });
  }
  if (accepted.length === 0) return { fixes, pr: null };

  const base = ctx.pr?.headRef ?? ctx.branch;
  const branch = `triage-agent/fix-${base}`.replace(/[^\w./-]/g, '-');
  const tree = join(ctx.outDir, 'fix-worktree');
  if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
  git(ctx.workspace, ['fetch', '--no-tags', 'origin', base]);
  git(ctx.workspace, ['worktree', 'add', '-B', branch, tree, `origin/${base}`]);
  try {
    const applied = accepted.filter(({ fix }) => applyFix(join(tree, relative(ctx.workspace, fix.specFile)), fix));
    if (applied.length === 0) return { fixes, pr: null };
    git(tree, ['add', '-A']);
    git(tree, ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '-m', `Fix ${applied.length} drifted locator(s), verified by re-running each test`]);
    git(tree, ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
    const pr = await github.upsertPullRequest(branch, base, `triage-agent: fix ${applied.length} drifted locator(s) (verified)`, prBody(ctx, applied));
    return { fixes, pr };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: ctx.workspace });
  }
}
