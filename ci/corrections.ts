// Reads the corrections people wrote under the agent's own comments. Anyone can reply to the PR
// comment (or the environment issue) with "/triage TIMING #3 flaky in CI" and the agent stores
// that with the run history, so later failures of that test failing the same way get the
// person's answer instead of its own. Only humans are read: the agent ignores its own comments.
import type { Correction } from '../engine/corrections.ts';
import { parseCorrectionCommands } from '../engine/corrections.ts';
import { errorShape } from '../engine/signature.ts';
import type { TriageItem } from '../outlets/items.ts';
import type { TriageRecord } from '../reporters/types.ts';
import type { GitHub } from './github.ts';

interface Comment {
  id: number;
  body: string | null;
  user: { login: string; type: string } | null;
  created_at: string;
  html_url: string;
  /** GitHub's relation of the author to the repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE... */
  author_association?: string;
}

/**
 * Only people who can already change the repository may correct the agent. A correction is
 * trusted like a maintainer's word (the merge gate lets a person's TIMING/ENV through), so on a
 * public repository a comment from anyone else must not be able to wave a real failure past it.
 */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const MAP_START = '<!-- triage-agent:map';

// Map fields are encoded, so no test name can close the hidden comment early ("-->") or break the
// map's separators, and the exact name comes back when a correction is read.
const encode = (v: string) => Buffer.from(v, 'utf8').toString('base64url');
const decode = (v: string) => Buffer.from(v, 'base64url').toString('utf8');

/** At most this many failures get a number; a larger run's comment is truncated long before. */
export const MAP_MAX = 200;

/**
 * The agent's comment carries a hidden map from the numbers people see to the failure each one
 * means. `items` must be in the order the comment shows them (commentOrder), so "#3" is the third
 * failure a person sees. `readAt` is when this run read the replies: a reply written after it
 * refers to this map, and replies written before it were already read against the map they saw.
 */
export function renderBoardMap(items: TriageItem[], records: TriageRecord[], readAt = new Date().toISOString()): string {
  const lines = items.slice(0, MAP_MAX).map((item, i) => {
    // The last failed attempt: it is the one diagnosed, so its error is the one a correction must match.
    const record = records.filter((r) => r.runId === item.runId && r.testId === item.testId).sort((a, b) => b.retry - a.retry)[0];
    return record ? [i + 1, encode(item.testId), encode(errorShape(record.errorMessage)), item.diagnosis.category].join('\t') : null;
  });
  return `${MAP_START} v2 ${readAt}\n${lines.filter(Boolean).join('\n')}\n-->`;
}

interface MappedFailure {
  testId: string;
  errorShape: string;
  was: string;
}

/** When the run that wrote this map read the replies; '' for maps written before this was recorded. */
export function boardMapTime(body: string): string {
  return body.split(MAP_START)[1]?.match(/^ v2 (\S+)/)?.[1] ?? '';
}

export function parseBoardMap(body: string): Map<number, MappedFailure> {
  const block = body.split(MAP_START)[1]?.split('-->')[0] ?? '';
  // "v2" maps encode their fields; maps written before that (plain text) are still read as they are.
  const read = block.startsWith(' v2') ? decode : (v: string) => v;
  const map = new Map<number, MappedFailure>();
  for (const line of block.split('\n').slice(1)) {
    const [n, testId, shape, was] = line.split('\t');
    if (n && testId && shape) map.set(Number(n), { testId: read(testId), errorShape: read(shape), was: was ?? '' });
  }
  return map;
}

/**
 * Corrections written under one issue or pull request. `items` and `records` are this run's
 * failures, used to turn "#3" into the test it means; a comment that names no number corrects
 * the only failure, and is ignored when there are several.
 */
/** Every comment on the issue or pull request, page by page: long discussions pass 100. */
async function allComments(github: GitHub, issueNumber: number): Promise<Comment[]> {
  const out: Comment[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await github.request<Comment[]>('GET', `/repos/{repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function readCorrections(github: GitHub, issueNumber: number, where: string, suite = ''): Promise<Correction[]> {
  const comments = await allComments(github, issueNumber);
  // This suite's own comment holds the map its numbers refer to. Only the agent's comment counts -
  // posted by a bot, or by a maintainer's token when the workflow uses one - since a map in anyone
  // else's comment could point "#1" at another test.
  const own = comments
    .filter((c) => (c.user?.type === 'Bot' || TRUSTED.has(c.author_association ?? '')) && c.body?.includes(commentMarker(suite)) && c.body.includes(MAP_START))
    .at(-1);
  const map = own ? parseBoardMap(own.body ?? '') : null;
  if (!map || map.size === 0) return [];
  // A reply written before this map was made referred to an earlier numbering, and was read then.
  const since = boardMapTime(own?.body ?? '');
  const out: Correction[] = [];
  for (const comment of comments) {
    if (!comment.body || comment.user?.type === 'Bot' || comment.body.includes(MAP_START)) continue;
    if (!TRUSTED.has(comment.author_association ?? '')) continue;
    if (since && comment.created_at <= since) continue;
    for (const parsed of parseCorrectionCommands(comment.body)) {
      if ((parsed.suite ?? '') !== suite) continue;
      const failure = map.get(parsed.item ?? (map.size === 1 ? 1 : -1));
      if (!failure) continue;
      out.push({
        schemaVersion: 1,
        testId: failure.testId,
        errorShape: failure.errorShape,
        category: parsed.category,
        by: comment.user?.login ?? 'unknown',
        at: comment.created_at,
        reason: parsed.reason,
        source: `${where} comment`,
        wasCategory: failure.was,
      });
    }
  }
  return out;
}

export const COMMENT_MARKER = '<!-- triage-agent:pr-comment -->';
/** One comment per suite: a named suite gets its own marker so suites do not overwrite each other. */
export const commentMarker = (suite: string) => (suite ? `<!-- triage-agent:pr-comment:${suite} -->` : COMMENT_MARKER);

/** The one line the agent adds to its comment so people know how to correct it. */
export function correctionHint(suite = ''): string {
  const ref = `${suite}#`;
  return `_Wrong? Reply \`/triage CATEGORY ${ref}n reason\` (e.g. \`/triage TIMING ${ref}2 flaky on CI\`) and the agent will use your answer for this failure from now on. Categories: REAL_BUG, LOCATOR_DRIFT, TIMING, ENV, TEST_DATA._`;
}
