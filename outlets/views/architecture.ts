// Architecture view: cross-cutting fragility over the whole window. Which areas and service
// dependencies cause the most product / environment failures, and which single changes broke
// many suites at once (a sign of coupling through shared code).
import type { TriageItem } from '../items.ts';
import { clean, itemBlock, sourceNote, type View } from '../view.ts';
import { groupEnv } from './infra.ts';

/** A run where one commit broke at least this many tests, or this many areas, counts as a wide break. */
const WIDE_BREAK_TESTS = 5;
const WIDE_BREAK_AREAS = 3;

export function architectureView(items: TriageItem[], dataset: string): View {
  const shown: TriageItem[] = [];
  const example = (i: TriageItem) => {
    shown.push(i);
    return itemBlock(i, ['(example)']);
  };

  const areas = [...new Set(items.map((i) => i.component))]
    .map((component) => {
      const xs = items.filter((i) => i.component === component);
      const count = (c: string) => xs.filter((i) => i.diagnosis.category === c).length;
      const bugs = xs.filter((i) => i.diagnosis.category === 'REAL_BUG');
      // Regressions a pull request introduced and CI caught before merge are the process working,
      // not fragility of the main branch, so they are counted apart.
      return {
        component,
        total: xs.length,
        bug: bugs.filter((i) => i.onDefaultBranch).length,
        caught: bugs.filter((i) => !i.onDefaultBranch).length,
        env: count('ENV'),
        timing: count('TIMING'),
      };
    })
    .sort((a, b) => b.bug + b.env - (a.bug + a.env) || b.total - a.total)
    .slice(0, 12);

  const bugsByRun = new Map<string, TriageItem[]>();
  for (const i of items.filter((x) => x.diagnosis.category === 'REAL_BUG')) bugsByRun.set(i.runId, [...(bugsByRun.get(i.runId) ?? []), i]);
  const wideBreaks = [...bugsByRun.values()]
    .map((xs) => ({ xs, areas: [...new Set(xs.map((i) => i.component))] }))
    .filter((b) => b.xs.length >= WIDE_BREAK_TESTS || b.areas.length >= WIDE_BREAK_AREAS)
    .sort((a, b) => b.xs.length - a.xs.length)
    .slice(0, 5);

  const deps = groupEnv(items).slice(0, 6);

  const markdown = [
    '# Architecture view: whole window',
    '',
    sourceNote(dataset),
    '',
    '## Fragility by area',
    '',
    '| Area | Failing cases | Product bugs (main branch) | Regressions caught in PRs | Environment | Flaky |',
    '|---|---:|---:|---:|---:|---:|',
    ...areas.map((a) => `| ${clean(a.component)} | ${a.total} | ${a.bug} | ${a.caught} | ${a.env} | ${a.timing} |`),
    '',
    `Next action: review the top area's dependencies and shared components first; product bugs and environment failures there cost every team.`,
    '',
    '## Single changes that broke many suites at once',
    '',
    ...(wideBreaks.length === 0
      ? ['None in this window.', '']
      : wideBreaks.flatMap((b) => [
          `### Commit \`${b.xs[0].commit.slice(0, 8)}\` (run ${clean(b.xs[0].runId)}${b.xs[0].onDefaultBranch ? '' : `, pull request branch ${clean(b.xs[0].branch)}, caught before merge`}): ${b.xs.length} test(s) across ${b.areas.length} area(s)`,
          `Areas: ${b.areas.map(clean).join(', ')}.`,
          'Next action: look at what this commit changed in shared code; one change breaking this many suites points to tight coupling.',
          '',
          example(b.xs[0]),
          '',
        ])),
    '## Service and environment dependencies that failed',
    '',
    ...(deps.length === 0
      ? ['None in this window.', '']
      : deps.flatMap((g) => [
          `### ${clean(g.signature)}: ${g.items.length} failure(s) in ${new Set(g.items.map((i) => i.runId)).size} run(s), ${g.recovered} recovered on retry`,
          'Next action: make this dependency more resilient (health check before the suite, retries on connection reset) or isolate the tests from it.',
          '',
          example(g.items[0]),
          '',
        ])),
  ].join('\n');

  return { id: 'architecture', role: 'architect', title: 'Architecture view', scope: 'window', items: [...new Set(shown)], markdown };
}
