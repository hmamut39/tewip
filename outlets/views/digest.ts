// Risk digest for leads / managers: which areas are getting worse, comparing the first and
// second half of the data window (a weekly digest when the window is two weeks).
import type { RunSummary } from '../../reporters/types.ts';
import { componentOf, type TriageItem } from '../items.ts';
import { clean, itemBlock, PLAIN_CATEGORY, sourceNote, type View } from '../view.ts';

/** Degrading: the failure rate grew by at least this factor, with at least MIN_FAILURES in the later half. */
const GROWTH = 1.5;
const MIN_FAILURES = 3;

/** Spec file inside a test id ("chromium > editor/blocks/image.spec.js > ..."), or its first segment. */
const fileOfTestId = (testId: string) => testId.split(' > ').find((s) => /\.(spec|test)\.[jt]sx?$/.test(s)) ?? testId.split(' > ')[0];

export function digestView(items: TriageItem[], summaries: RunSummary[], dataset: string): View {
  const times = summaries.map((s) => s.startedAt).sort();
  const middle = times[Math.floor(times.length / 2)] ?? '';
  const half = (at: string) => (at < middle ? 0 : 1);
  const period = (h: number) => (h === 0 ? `${times[0]?.slice(0, 10)} to ${middle.slice(0, 10)}` : `${middle.slice(0, 10)} to ${times.at(-1)?.slice(0, 10)}`);

  const attempts = new Map<string, [number, number]>();
  for (const s of summaries) {
    for (const [testId, n] of Object.entries(s.attempts)) {
      const c = componentOf(fileOfTestId(testId));
      const a = attempts.get(c) ?? [0, 0];
      a[half(s.startedAt)] += n;
      attempts.set(c, a);
    }
  }

  const rows = [...attempts.entries()]
    .map(([component, [a0, a1]]) => {
      const xs = items.filter((i) => i.component === component);
      const f0 = xs.filter((i) => half(i.timestamp) === 0).length;
      const later = xs.filter((i) => half(i.timestamp) === 1);
      return { component, r0: a0 ? f0 / a0 : 0, r1: a1 ? later.length / a1 : 0, f0, later };
    })
    .filter((r) => r.later.length >= MIN_FAILURES && r.r1 >= r.r0 * GROWTH)
    .sort((a, b) => b.r1 - a.r1)
    .slice(0, 6);

  const shown: TriageItem[] = [];
  const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
  const main = (xs: TriageItem[]) => {
    const counts = new Map<string, number>();
    for (const i of xs) counts.set(i.diagnosis.category, (counts.get(i.diagnosis.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as keyof typeof PLAIN_CATEGORY;
  };

  const markdown = [
    '# Risk digest',
    '',
    `Comparing ${period(0)} with ${period(1)}. ${rows.length === 0 ? 'No area got noticeably worse.' : `${rows.length} area(s) got worse.`}`,
    '',
    sourceNote(dataset),
    '',
    ...rows.flatMap((r) => {
      const example = [...r.later].sort((a, b) => b.diagnosis.confidence - a.diagnosis.confidence)[0];
      shown.push(example);
      return [
        `## ${clean(r.component)}: failure rate ${pct(r.r0)} → ${pct(r.r1)} (${r.later.length} failures, mostly ${PLAIN_CATEGORY[main(r.later)]})`,
        `Next action: ask the "${clean(r.component)}" owners to review the new failures this week.`,
        '',
        itemBlock(example, ['(example)']),
        '',
      ];
    }),
  ].join('\n');

  return { id: 'digest', role: 'lead', title: 'Risk digest', scope: 'window', items: shown, markdown };
}
