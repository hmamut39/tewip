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

/**
 * The agent's comment carries a hidden map from the numbers people see to the failure each one
 * means, so "#3" keeps meaning the same test even when the next run lists failures differently.
 */
export function renderBoardMap(items: TriageItem[], records: TriageRecord[]): string {
  const lines = items.map((item, i) => {
    const record = records.find((r) => r.runId === item.runId && r.testId === item.testId);
    return record ? [i + 1, encode(item.testId), encode(errorShape(record.errorMessage)), item.diagnosis.category].join('\t') : null;
  });
  return `${MAP_START} v2\n${lines.filter(Boolean).join('\n')}\n-->`;
}

interface MappedFailure {
  testId: string;
  errorShape: string;
  was: string;
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
export async function readCorrections(github: GitHub, issueNumber: number, where: string, suite = ''): Promise<Correction[]> {
  const comments = await github.request<Comment[]>('GET', `/repos/{repo}/issues/${issueNumber}/comments?per_page=100`);
  // This suite's own comment holds the map its numbers refer to.
  const map = comments
    // Only the agent's own comment: a map in anyone else's comment could point "#1" at another test.
    .filter((c) => c.user?.type === 'Bot' && c.body?.includes(commentMarker(suite)) && c.body.includes(MAP_START))
    .map((c) => parseBoardMap(c.body ?? ''))
    .at(-1);
  if (!map || map.size === 0) return [];
  const out: Correction[] = [];
  for (const comment of comments) {
    if (!comment.body || comment.user?.type === 'Bot' || comment.body.includes(MAP_START)) continue;
    if (!TRUSTED.has(comment.author_association ?? '')) continue;
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
