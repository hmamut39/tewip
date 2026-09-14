// CLI triage board for SDETs: every failure of the run, grouped by what to do next.
import type { ActionKind } from '../../engine/decide.ts';
import type { TriageItem } from '../items.ts';
import { itemBlock, sourceNote, type View } from '../view.ts';

const ORDER: Array<{ kind: ActionKind; title: string }> = [
  { kind: 'escalate', title: 'Needs a human decision' },
  { kind: 'fix-locator', title: 'Fix a locator (UI changed)' },
  { kind: 'fix-wait', title: 'Replace a fixed wait' },
  { kind: 'stabilize-test', title: 'Stabilize a flaky test' },
  { kind: 'fix-precondition', title: 'Fix test data / setup' },
  { kind: 'file-bug', title: 'Product bugs: file and move on' },
  { kind: 'rerun-and-notify', title: 'Environment: re-run, do not touch the test' },
];

export function sdetBoardView(items: TriageItem[], runId: string, dataset: string): View {
  const counts = ORDER.map(({ kind, title }) => ({ title, n: items.filter((i) => i.action.kind === kind).length })).filter((c) => c.n > 0);
  const agentCan = items.filter((i) => i.action.autonomous).length;

  const markdown = [
    `# Triage board: run ${runId}`,
    '',
    `${items.length} failing test(s). ${agentCan} can be handled by the agent without a human (once each action is automated); ${items.length - agentCan} need a person.`,
    '',
    sourceNote(dataset),
    '',
    ...counts.map((c) => `- ${c.title}: **${c.n}**`),
    '',
    ...ORDER.flatMap(({ kind, title }) => {
      const xs = items.filter((i) => i.action.kind === kind);
      return xs.length === 0 ? [] : [`## ${title} (${xs.length})`, '', ...xs.map((i) => itemBlock(i, [`Why this action: ${i.action.reason}`])), ''];
    }),
  ].join('\n');

  return { id: 'sdet-board', role: 'sdet', title: `SDET triage board for run ${runId}`, scope: 'run', items, markdown };
}
