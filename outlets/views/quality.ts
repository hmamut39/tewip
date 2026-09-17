// Engineering-quality view for senior / principal engineers, over the whole dataset window:
// flakiness hotspots, recurring root-cause patterns and test-design debt ranked by CI cost.
import { errorShape, truncate } from '../../engine/signature.ts';
import type { TriageItem } from '../items.ts';
import { clean, itemBlock, PLAIN_CATEGORY, sourceNote, type View } from '../view.ts';

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} CI min`;
const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.entries()];
};
const wasted = (xs: TriageItem[]) => xs.reduce((sum, i) => sum + i.wastedMs, 0);
/** Separate runs a test must have flaked in before it is worth naming for quarantine. */
const QUARANTINE_MIN_RUNS = 2;

/** The shortest tail of a test's name that no other listed test shares, so rows stay telling apart. */
function name(testId: string, others: Array<{ testId: string }>): string {
  const parts = testId.split(' > ');
  for (let take = 1; take < parts.length; take++) {
    const tail = parts.slice(-take).join(' > ');
    if (others.filter((o) => o.testId.endsWith(tail)).length === 1) return tail;
  }
  return testId;
}

export function qualityView(items: TriageItem[], dataset: string): View {
  const shown: TriageItem[] = [];
  const example = (xs: TriageItem[]) => {
    const pick = [...xs].sort((a, b) => b.diagnosis.confidence - a.diagnosis.confidence)[0];
    shown.push(pick);
    return itemBlock(pick, ['(example)']);
  };

  const hotspots = groupBy(items.filter((i) => i.diagnosis.category === 'TIMING'), (i) => i.component)
    .map(([component, xs]) => ({ component, xs, tests: new Set(xs.map((i) => i.testId)).size }))
    .sort((a, b) => wasted(b.xs) - wasted(a.xs))
    .slice(0, 8);

  // The flaky tests that cost the most, named one by one: a hotspot per component tells a lead
  // where to look, but an SDET needs the list of tests to quarantine this morning.
  const quarantine = groupBy(items.filter((i) => i.diagnosis.category === 'TIMING'), (i) => i.testId)
    .map(([testId, xs]) => ({ testId, xs, runs: new Set(xs.map((i) => i.runId)).size }))
    .filter((q) => q.runs >= QUARANTINE_MIN_RUNS)
    .sort((a, b) => wasted(b.xs) - wasted(a.xs))
    .slice(0, 5);

  const patterns = groupBy(items, (i) => `${i.diagnosis.category} ${truncate(errorShape(i.errorHead), 90)}`)
    .filter(([, xs]) => xs.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6);

  const debt = groupBy(
    items.flatMap((i) => i.debt.map((d) => ({ d, i }))),
    (x) => `${x.d.kind} ${x.d.detail}`,
  )
    .map(([, xs]) => ({ debt: xs[0].d, xs: xs.map((x) => x.i) }))
    .sort((a, b) => wasted(b.xs) - wasted(a.xs))
    .slice(0, 10);

  const markdown = [
    '# Engineering quality: whole window',
    '',
    `${items.length} failing test case(s), ${minutes(wasted(items))} spent on failed attempts.`,
    '',
    sourceNote(dataset),
    '',
    '## Flakiness hotspots (TIMING), ranked by CI time lost',
    '',
    ...(hotspots.length === 0
      ? ['None.', '']
      : hotspots.flatMap((h) => [
          `### ${h.component}: ${h.xs.length} flaky failure(s) in ${h.tests} test(s), ${minutes(wasted(h.xs))}`,
          `Next action: give "${h.component}" an owner to stabilize its flakiest test first.`,
          '',
          example(h.xs),
          '',
        ])),
    '## Quarantine candidates: flaky tests ranked by CI time lost',
    '',
    ...(quarantine.length === 0
      ? [`None: no test was diagnosed TIMING in ${QUARANTINE_MIN_RUNS} or more separate runs.`, '']
      : [
          `| Test | File | Failed runs | CI time lost | Next action |`,
          `|---|---|---:|---:|---|`,
          ...quarantine.map((q) => {
            const first = q.xs[0];
            return `| ${clean(name(q.testId, quarantine))} | \`${first.file}\` | ${q.runs} | ${minutes(wasted(q.xs))} | Quarantine it (\`test.fixme\`) and open one issue to fix the race; it is costing this much every window |`;
          }),
          '',
          'Quarantining stops a flaky test from blocking other people while the race is fixed. It is a decision for a person: the agent never edits a test to skip it.',
          '',
        ]),
    '## Recurring root-cause patterns (3+ occurrences)',
    '',
    ...(patterns.length === 0
      ? ['None.', '']
      : patterns.flatMap(([key, xs]) => [
          `### ${xs.length}x ${PLAIN_CATEGORY[xs[0].diagnosis.category]}: ${clean(key.slice(key.indexOf(' ') + 1)) || '(no error text)'}`,
          `Next action: fix the shared cause once instead of triaging ${xs.length} failures one by one.`,
          '',
          example(xs),
          '',
        ])),
    '## Test-design debt, ranked by CI time lost',
    '',
    ...(debt.length === 0
      ? ['No fixed waits or brittle selectors found near the failing lines.', '']
      : debt.flatMap((d) => [
          `### ${d.debt.kind === 'hard-wait' ? 'Fixed wait' : 'Brittle selector'}: \`${clean(d.debt.detail)}\` (${d.xs.length} failure(s), ${minutes(wasted(d.xs))})`,
          `Next action: ${d.debt.kind === 'hard-wait' ? 'replace it with a web-first assertion on the awaited element' : 'switch to a role, label or test-id locator'}.`,
          '',
          example(d.xs),
          '',
        ])),
  ].join('\n');

  return { id: 'quality', role: 'senior-engineer', title: 'Engineering quality view', scope: 'window', items: [...new Set(shown)], markdown };
}
