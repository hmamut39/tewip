// Delivery: the developer's PR comment, the DevOps environment issue, and the SDET board in the
// job summary. Bodies are the same role views the CLI writes (one engine, many outlets).
import { appendFileSync } from 'node:fs';
import type { FixResult } from '../engine/autofix/autofix.ts';
import type { TriageItem } from '../outlets/items.ts';
import { prCommentView } from '../outlets/views/developer.ts';
import { groupEnv, infraView } from '../outlets/views/infra.ts';
import { usageLine } from '../engine/llm/usage.ts';
import { sdetBoardView } from '../outlets/views/sdet.ts';
import type { TriageRecord } from '../reporters/types.ts';
import { CORRECTION_HINT, renderBoardMap } from './corrections.ts';
import type { CiContext } from './context.ts';
import type { GitHub, IssueRef } from './github.ts';

export const COMMENT_MARKER = '<!-- triage-agent:pr-comment -->';
export const ENV_MARKER = '<!-- triage-agent:env-issue -->';
/** GitHub rejects comment bodies over 65,536 characters. */
const MAX_BODY = 60_000;

const fit = (body: string, runUrl: string) =>
  body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY)}\n\n…truncated: the full report is in the \`triage-agent-report\` artifact of [this run](${runUrl}).`;

export function prCommentBody(ctx: CiContext, items: TriageItem[], fixPr: IssueRef | null, fixes: FixResult[], records: TriageRecord[] = []): string {
  const footer = `<sub>[CI run](${ctx.runUrl}) · every role's view is in the \`triage-agent-report\` artifact · triage-agent never merges and never edits application code</sub>`;
  if (items.length === 0) return `## triage-agent: all tests passed on \`${ctx.sha.slice(0, 8)}\`\n\n${footer}`;
  const accepted = fixes.filter((f) => f.applied).length;
  const fixLine = fixPr
    ? `\n\n**Verified locator fixes: ${fixPr.html_url}** (${accepted} test(s) re-run and passing with the new locator). Review before merging: an intended UI change and a regression can look alike.`
    : '';
  // The hidden map keeps "#3" meaning the same failure in later runs; the hint tells people how.
  const learn = `\n\n${CORRECTION_HINT}\n${renderBoardMap(items, records)}`;
  return fit(`${prCommentView(items, ctx.runId, ctx.repo).markdown}${fixLine}${learn}\n\n${footer}`, ctx.runUrl);
}

export async function postPrComment(ctx: CiContext, github: GitHub, body: string): Promise<string | null> {
  if (!ctx.pr || !ctx.postPrComment) return null;
  return github.upsertComment(ctx.pr.number, COMMENT_MARKER, body);
}

/** One open issue collects environment failures; each run adds one grouped alert to it. */
export async function postEnvIssue(ctx: CiContext, github: GitHub, items: TriageItem[]): Promise<IssueRef | null> {
  const groups = groupEnv(items);
  if (!ctx.envIssue || groups.length === 0) return null;
  const env = groups.flatMap((g) => g.items);
  const where = ctx.pr ? `PR #${ctx.pr.number}` : `\`${ctx.branch}\``;
  const alert = [
    `### ${env.length} environment failure(s) in [run ${ctx.runId}](${ctx.runUrl}) (${where}, \`${ctx.sha.slice(0, 8)}\`)`,
    ...groups.map((g) => `- **${g.signature}**: ${g.items.length} test(s), ${g.recovered} recovered on retry`),
    '',
    'Test code was not changed. Re-run once; if it fails again, check the dependency above.',
  ].join('\n');
  const body = fit(`Environment failures detected by triage-agent. New runs add a comment here instead of opening new issues.\n\n${infraView(items, ctx.runId, ctx.repo).markdown}`, ctx.runUrl);
  return github.upsertIssue(ENV_MARKER, 'triage-agent: test environment failures', body, alert);
}

/** The SDET board as the job summary, visible on the workflow run page without downloads. */
export function writeStepSummary(ctx: CiContext, items: TriageItem[]): void {
  if (!ctx.stepSummary) return;
  const body = items.length === 0 ? '## triage-agent\n\nNo failing tests.' : sdetBoardView(items, ctx.runId, ctx.repo).markdown;
  appendFileSync(ctx.stepSummary, `${body.slice(0, 900_000)}\n\n_${usageLine()}_\n`, 'utf8');
}
