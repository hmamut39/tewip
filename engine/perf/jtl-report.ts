// Phase 39: what Tewip says about a JMeter run.
//
// Kept apart from perf-command.ts because a .jtl is answered differently from a k6 summary or a
// Lighthouse report, and for a good reason rather than a tidy one: those two hand over aggregates,
// so the only question available is "is this number outside the baseline range". A .jtl hands over
// every request, so the question becomes "are these two distributions different", which is a
// better question with a real answer - per label, not just overall.
import { byLabel, overall, readJtlSamples, type LabelSamples } from './jtl.ts';
import { compareSamples, ENOUGH_SAMPLES, median, type SampleVerdict } from './samples.ts';

export interface LabelComparison {
  label: string;
  verdict: SampleVerdict;
  /** Failures now, which are a separate matter from speed and reported separately. */
  failedNow: number;
  totalNow: number;
  codes: Array<{ code: string; times: number }>;
}

export interface JtlResult {
  comparisons: LabelComparison[];
  slower: LabelComparison[];
  failing: LabelComparison[];
  requests: number;
  report: string;
}

const ms = (n: number) => `${Math.round(n * 10) / 10}ms`;

/** A run on its own: no baseline to compare against, so nothing is claimed about a change. */
export function describeRun(groups: LabelSamples[], total: number): string {
  const lines = ['# Tewip performance check', ''];
  lines.push(`Read a JMeter run of **${total} requests** across ${groups.length} ${groups.length === 1 ? 'label' : 'labels'}.`, '');
  lines.push(
    '**No baseline given, so nothing is said about whether this is slower.** Pass the previous run ' +
      'with `--against baseline.jtl` and Tewip will compare the two request by request.',
    '',
  );
  lines.push('## What this run did', '');
  lines.push('| Label | Requests | Failed | Median | p95 |', '| --- | --- | --- | --- | --- |');
  for (const g of groups) {
    lines.push(`| ${g.label || '(unnamed)'} | ${g.total} | ${g.failed} | ${ms(median(g.elapsed))} | ${ms(percentile(g.elapsed, 95))} |`);
  }
  lines.push('');
  const failing = groups.filter((g) => g.failed > 0);
  if (failing.length > 0) {
    lines.push('## Requests that failed', '');
    for (const g of failing) {
      const codes = g.codes.map((c) => `${c.code} x${c.times}`).join(', ');
      // A 2xx that still counts as failed is an assertion failing, not the server.
      const assertion = g.codes.some((c) => /^2\d\d/.test(c.code)) ? ' - a 2xx counted as failed is an assertion, not the server' : '';
      lines.push(`- **${g.label || '(unnamed)'}**: ${g.failed} of ${g.total}${codes ? ` (${codes})` : ''}${assertion}`);
    }
    lines.push('');
  }
  lines.push(...notKnown());
  return lines.join('\n');
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, at)];
}

function notKnown(): string[] {
  return [
    '## What this does not tell you',
    '',
    '- **Nothing about production.** This is the hardware the run happened on, with that data volume and ' +
      'that concurrency. Tewip cannot see your real machines, your real data or your real traffic.',
    '- **No duration is predicted**, and no capacity. It says whether the two runs differ, not how many users you could hold.',
    '- **Only what the plan exercised.** An endpoint the test never called is not covered, however green this looks.',
    '- **A statistical difference is not a cause.** Tewip says the distributions moved; why they moved is in your change.',
    '',
  ];
}

/** Two runs, compared request by request. */
export function compareRuns(nowPath: string, beforePath: string): JtlResult {
  const nowSamples = readJtlSamples(nowPath);
  const beforeSamples = readJtlSamples(beforePath);
  const nowGroups = byLabel(nowSamples);
  const beforeByLabel = new Map(byLabel(beforeSamples).map((g) => [g.label, g]));

  const comparisons: LabelComparison[] = [];
  // The whole run first: it is the headline, and a change that moves everything is the common case.
  const everything = compareSamples(overall(nowSamples).elapsed, overall(beforeSamples).elapsed);
  comparisons.push({
    label: 'all requests',
    verdict: everything,
    failedNow: overall(nowSamples).failed,
    totalNow: nowSamples.length,
    codes: [],
  });

  for (const group of nowGroups) {
    const before = beforeByLabel.get(group.label);
    const verdict = before
      ? compareSamples(group.elapsed, before.elapsed)
      : {
          direction: 'cannot-say' as const,
          now: median(group.elapsed),
          before: 0,
          slowerThanBefore: 0.5,
          p: null,
          sampleSize: { now: group.total, before: 0 },
          why: 'this label is not in the baseline run, so there is nothing to compare it with',
        };
    comparisons.push({ label: group.label, verdict, failedNow: group.failed, totalNow: group.total, codes: group.codes });
  }

  const slower = comparisons.filter((c) => c.verdict.direction === 'slower');
  const failing = comparisons.filter((c) => c.failedNow > 0);
  return { comparisons, slower, failing, requests: nowSamples.length, report: render(comparisons, slower, failing, nowSamples.length, beforeSamples.length) };
}

function render(all: LabelComparison[], slower: LabelComparison[], failing: LabelComparison[], now: number, before: number): string {
  const lines = ['# Tewip performance check', ''];
  lines.push(`Compared a JMeter run of **${now} requests** against a baseline of **${before}**, request by request.`, '');

  if (slower.length > 0) lines.push(`**${slower.length} ${slower.length === 1 ? 'label is' : 'labels are'} slower than the baseline, by more than the runs explain.**`, '');
  const faster = all.filter((c) => c.verdict.direction === 'faster');
  if (faster.length > 0) lines.push(`${faster.length} ${faster.length === 1 ? 'is' : 'are'} faster.`, '');
  if (slower.length === 0 && faster.length === 0) lines.push('**No difference these two runs can establish.**', '');
  if (failing.length > 0) lines.push(`**${failing.reduce((n, c) => n + c.failedNow, 0)} requests failed**, which is a separate matter from speed and is below.`, '');

  lines.push('## Is it slower?', '');
  for (const c of all) {
    const mark = c.verdict.direction === 'slower' ? '**slower**' : c.verdict.direction === 'faster' ? 'faster' : 'cannot say';
    lines.push(`- \`${c.label || '(unnamed)'}\` — ${mark}`);
    lines.push(`  - median ${ms(c.verdict.before)} → ${ms(c.verdict.now)} over ${c.verdict.sampleSize.before} and ${c.verdict.sampleSize.now} requests`);
    lines.push(`  - ${c.verdict.why}`);
  }
  lines.push('');

  if (failing.length > 0) {
    lines.push('## Requests that failed', '');
    for (const c of failing) {
      const codes = c.codes.map((x) => `${x.code} x${x.times}`).join(', ');
      const assertion = c.codes.some((x) => /^2\d\d/.test(x.code)) ? ' - a 2xx counted as failed is an assertion failing, not the server' : '';
      lines.push(`- **${c.label || '(unnamed)'}**: ${c.failedNow} of ${c.totalNow}${codes ? ` (${codes})` : ''}${assertion}`);
    }
    lines.push('');
    lines.push('A run with failures in it is a run whose timings describe something that did not work.', '');
  }

  const thin = all.filter((c) => c.verdict.p === null && c.verdict.sampleSize.before > 0);
  if (thin.length > 0) {
    lines.push(
      `${thin.length} ${thin.length === 1 ? 'label has' : 'labels have'} fewer than ${ENOUGH_SAMPLES} requests on one ` +
        'side, so no test was run for them. That is said above rather than guessed at.',
      '',
    );
  }

  lines.push(...notKnown());
  return lines.join('\n');
}
