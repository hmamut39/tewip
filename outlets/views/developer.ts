// PR comment for developers: which failures in this run are likely caused by their change.
import { errorShape, truncate } from '../../engine/signature.ts';
import type { TriageItem } from '../items.ts';
import { itemBlock, sourceNote, type View } from '../view.ts';

/** Failures sharing a cause, before this many are read one by one, get a single line up front. */
const SHARED_CAUSE_MIN = 3;

/**
 * Groups of failures with the same category and the same error: one outage or one changed
 * component often fails many tests, and the reader should see that before twenty entries.
 */
export function sharedCauses(items: TriageItem[]): Array<{ category: string; error: string; items: TriageItem[] }> {
  const groups = new Map<string, TriageItem[]>();
  // Undecided failures are left out: the agent does not know their cause, so it cannot say two share one.
  for (const i of items.filter((x) => x.diagnosis.category !== 'UNKNOWN')) {
    // The locator is part of the cause: two tests timing out on different elements are two problems.
    const key = [i.diagnosis.category, errorShape(i.errorHead), i.locator ?? ''].join('|');
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.entries()]
    .filter(([, xs]) => xs.length >= SHARED_CAUSE_MIN)
    .map(([key, xs]) => ({ category: key.split('|')[0], error: xs[0].errorHead, items: xs }))
    .sort((a, b) => b.items.length - a.items.length);
}

export function prCommentView(items: TriageItem[], runId: string, dataset: string): View {
  const commit = items[0]?.commit.slice(0, 8) || 'unknown commit';
  const by = (verdict: TriageItem['relation']['verdict']) => items.filter((i) => i.relation.verdict === verdict);
  const likely = by('likely-this-change');
  const not = by('not-this-change');
  const unclear = by('unclear');
  const section = (title: string, xs: TriageItem[]) =>
    xs.length === 0 ? [] : [`### ${title} (${xs.length})`, '', ...xs.map((i) => itemBlock(i, [`Related to your change? ${i.relation.why}`])), ''];

  // Nothing failed: say so plainly instead of an empty list under "0 failing test(s)".
  if (items.length === 0) {
    const markdown = ['## triage-agent: all tests passed', '', 'Nothing to triage in this run.', '', sourceNote(dataset), ''].join('\n');
    return { id: 'pr-comment', role: 'developer', title: `PR comment for run ${runId}`, scope: 'run', items, markdown };
  }
  const markdown = [
    `## triage-agent: ${items.length} failing test(s) on \`${commit}\``,
    '',
    `**${likely.length} likely caused by this change**, ${not.length} probably not, ${unclear.length} unclear.`,
    '',
    ...sharedCauses(items).slice(0, 3).map((g) => `> **${g.items.length} failures look like one cause** (${g.category}, same error${g.items[0].locator ? ' on the same element' : ''}): \`${truncate(g.error, 110)}\`. Fixing it once may clear them all.`),
    ...(sharedCauses(items).length > 0 ? [''] : []),
    sourceNote(dataset),
    '',
    ...section('Likely caused by this change', likely),
    ...section('Probably not caused by this change', not),
    ...section('Unclear', unclear),
  ].join('\n');

  return { id: 'pr-comment', role: 'developer', title: `PR comment for run ${runId}`, scope: 'run', items, markdown };
}
