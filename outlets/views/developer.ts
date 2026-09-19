// PR comment for developers: which failures in this run are likely caused by their change.
import type { TriageItem } from '../items.ts';
import { itemBlock, sourceNote, type View } from '../view.ts';

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
    sourceNote(dataset),
    '',
    ...section('Likely caused by this change', likely),
    ...section('Probably not caused by this change', not),
    ...section('Unclear', unclear),
  ].join('\n');

  return { id: 'pr-comment', role: 'developer', title: `PR comment for run ${runId}`, scope: 'run', items, markdown };
}
