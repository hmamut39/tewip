// Phase 30, extended in Phase 31: `tewip perf` - is this change slower, and does it matter?
//
// Reads a k6 run (what a server does under load) or a Lighthouse report (what one page load costs in
// a browser), whichever it is handed, and answers two questions separately because they fail
// separately:
//
//   1. **Is anything in a bad state right now?** From the team's own k6 thresholds, or from
//      Lighthouse's published scoring bands. Never from a budget Tewip invented.
//   2. **Is it slower than it was?** Only from repeated baselines, and refused below three, because
//      one run against one run is not evidence. Four real k6 runs of unchanged code gave p95 of
//      60.8-62.8ms; four real Lighthouse runs of an unchanged page gave LCP of 912-936ms. Both move
//      on their own, and a tool that calls that a regression is muted within a week.
//
// It never predicts a duration, a capacity or a user impact: it cannot see the production hardware,
// the real data volume or the real traffic, and an invented number for any of those is worse than
// silence.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readK6Summary, requestCount } from './k6.ts';
import { isLighthouseFile, readLighthouse, type ManualCheck } from './lighthouse.ts';
import { fromK6, metricsInOrder, show, type ComparableRun } from './run.ts';
import { compareMetric, ENOUGH_BASELINES, type Comparison } from './compare.ts';
import { baselineFor, fromSameTool, knownLabels, recordRun, storedRuns } from './history.ts';
import { byLabel, readJtlSamples } from './jtl.ts';
import { compareRuns, describeRun } from './jtl-report.ts';

export interface PerfCommand {
  root: string;
  /** A k6 --summary-export JSON, a Lighthouse --output=json report, or a JMeter .jtl. */
  summary: string;
  /** For a JMeter run: the earlier .jtl to compare against, request by request. */
  against?: string;
  label?: string;
  record?: boolean;
  out?: string;
  gate?: boolean;
  gitSha?: string;
}

export interface PerfResult {
  run: ComparableRun;
  comparisons: Comparison[];
  regressed: boolean;
  breached: boolean;
  report: string;
}

/** Enough requests for a percentile to mean anything. Below this, p95 is three data points. */
export const ENOUGH_REQUESTS = 100;

export function readPerfFile(path: string): { run: ComparableRun; manual: ManualCheck[]; url: string } {
  if (isLighthouseFile(path)) {
    const report = readLighthouse(path);
    return { run: report.run, manual: report.manual, url: report.url };
  }
  const k6 = readK6Summary(path);
  return { run: fromK6(k6, requestCount(k6)), manual: [], url: '' };
}

export function renderPerf(
  run: ComparableRun,
  comparisons: Comparison[],
  label: string,
  baselineCount: number,
  recorded: boolean,
  manual: ManualCheck[] = [],
): string {
  const lines = ['# Tewip performance check', ''];
  const breaches = (run.thresholds ?? []).filter((t) => t.breached);
  const poor = Object.entries(run.metrics).filter(([, m]) => m.rating === 'poor');
  const slower = comparisons.filter((c) => c.direction === 'slower');
  const faster = comparisons.filter((c) => c.direction === 'faster');
  const unsure = comparisons.filter((c) => c.direction === 'cannot-say');
  const tool = run.source === 'k6' ? 'k6' : 'Lighthouse';

  lines.push(
    `Read a ${tool} run of **${run.volume.n} ${run.volume.kind}${run.volume.n === 1 ? '' : 's'}**, compared against **${baselineCount}** recorded ` +
      `${tool} baseline ${baselineCount === 1 ? 'run' : 'runs'} for \`${label}\`.`,
    '',
  );

  if (breaches.length > 0) lines.push(`**${breaches.length} of your own thresholds ${breaches.length === 1 ? 'was' : 'were'} breached.**`, '');
  if (poor.length > 0) lines.push(`**${poor.length} ${poor.length === 1 ? 'metric is' : 'metrics are'} in ${tool}'s worst band.**`, '');
  if (slower.length > 0) lines.push(`**${slower.length} ${slower.length === 1 ? 'metric is' : 'metrics are'} slower than the baseline runs can explain.**`, '');
  if (breaches.length === 0 && poor.length === 0 && slower.length === 0) {
    lines.push(
      run.thresholds === null
        ? '**No regression this baseline can detect.** Your thresholds are not in this export, so nothing is said about them.'
        : '**Nothing in a bad state, and no regression this baseline can detect.**',
      '',
    );
  }

  lines.push('## Is anything in a bad state right now?', '');
  if (run.source === 'k6') {
    if (run.thresholds === null) {
      lines.push(
        '**Cannot say.** This summary came from `--new-machine-readable-summary`, and that export records no threshold ' +
          'results at all - the word appears in it only inside the copy of your script. Tewip will not report "nothing was ' +
          'breached" from a file that does not say. Re-run with plain `--summary-export` to get the answer.',
        '',
      );
    } else if (run.thresholds.length === 0) {
      lines.push('This run has no thresholds. Add them to your k6 script and the team decides what "fast enough" means, rather than Tewip.', '');
    } else {
      for (const t of run.thresholds) lines.push(`- ${t.breached ? '**breached**' : 'held'} — \`${t.metric}\`: \`${t.expression}\``);
      lines.push('');
    }
  } else {
    // The bands are Lighthouse's own, computed by Lighthouse. Tewip is relaying a judgement with a
    // published basis, not applying numbers it chose.
    lines.push("Rated by Lighthouse's own scoring, not by any threshold Tewip invented:", '');
    for (const name of metricsInOrder(run)) {
      const m = run.metrics[name];
      if (m.rating === null) continue;
      const mark = m.rating === 'poor' ? '**poor**' : m.rating === 'needs-improvement' ? 'needs improvement' : 'good';
      lines.push(`- ${mark} — \`${name}\`: ${show(m)}`);
    }
    lines.push('');
  }

  lines.push('## Is it slower than it was?', '');
  if (baselineCount < ENOUGH_BASELINES) {
    lines.push(
      `**Cannot say.** There ${baselineCount === 1 ? 'is' : 'are'} ${baselineCount} recorded ${tool} ${baselineCount === 1 ? 'run' : 'runs'} ` +
        `for \`${label}\`, and Tewip needs ${ENOUGH_BASELINES} before it will call anything a regression. Performance numbers move ` +
        'between identical runs, and without several of them there is no way to tell a change from the machine having a busy moment. ' +
        'Record baselines on your main branch with `tewip perf <file> --record`.',
      '',
    );
  }
  for (const c of [...slower, ...faster, ...unsure]) {
    const verdict = c.direction === 'slower' ? '**slower**' : c.direction === 'faster' ? 'faster' : 'cannot say';
    const unit = run.metrics[c.metric]?.unit ?? 'ms';
    const u = (n: number) => (unit === 'ms' ? `${n}ms` : `${n}`);
    lines.push(`- \`${c.metric}\` ${u(c.now)} — ${verdict}`);
    lines.push(`  - baseline ${u(c.baselineLow)}–${u(c.baselineHigh)} over ${c.baselineRuns} runs, middle ${u(c.before)}`);
    lines.push(`  - ${c.why}`);
  }
  lines.push('');

  if (run.source === 'k6' && run.volume.n < ENOUGH_REQUESTS) {
    lines.push(
      `**${run.volume.n} requests is thin.** A p95 from this few is a handful of data points and will move on its own. ` +
        'Treat everything above as indicative and lengthen the run before deciding anything.',
      '',
    );
  }

  lines.push('## What this does not tell you', '');
  lines.push(
    '- **Nothing about production.** This is the hardware the run happened on, with that data volume and that ' +
      'concurrency. Tewip cannot see your real machines, your real data or your real traffic, and will not guess.',
    '- **No duration is predicted.** How long a real user waits depends on network, device and cache, none of which are here.',
    '- **Only what the run exercised.** A page or endpoint it never touched is not covered, however green this looks.',
    '- **Not capacity.** This says whether it changed, not how many users it would hold.',
  );
  if (run.source === 'lighthouse') {
    lines.push(
      `- **One page load.** k6 reports a percentile over many requests; this is a single load of one page, and a single ` +
        'load is the noisiest measurement either tool offers.',
    );
    if (manual.length > 0) {
      lines.push(
        `- **${manual.length} accessibility checks Lighthouse refuses to score** and hands to a person - ` +
          `${manual.slice(0, 3).map((m) => `\`${m.id}\``).join(', ')} and others. They are not failures and not passes. ` +
          'Run `tewip access` for the accessibility side.',
      );
    }
  }
  lines.push('');

  if (recorded) lines.push(`This run was added to the baseline for \`${label}\`.`, '');
  else lines.push('This run was **not** recorded. Add `--record` on your main branch to make it part of the baseline; a regression recorded by accident becomes next week\'s normal.', '');

  return lines.join('\n');
}


/**
 * A JMeter run. With `--against` the two are compared request by request; without it the run is
 * described and nothing is claimed about a change, because one run is not a comparison.
 */
function runJtl(root: string, cmd: PerfCommand): undefined {
  const now = resolve(root, cmd.summary);
  if (!cmd.against) {
    const samples = readJtlSamples(now);
    const report = describeRun(byLabel(samples), samples.length);
    console.log(report);
    if (cmd.out) writeOut(root, cmd.out, report);
    return undefined;
  }

  const result = compareRuns(now, resolve(root, cmd.against));
  console.log(result.report);
  if (cmd.out) writeOut(root, cmd.out, result.report);

  // Failures are a separate matter from speed and gate on their own: a run whose requests failed
  // is a run whose timings describe something that did not work.
  const failed = result.failing.reduce((n, c) => n + c.failedNow, 0);
  if (cmd.gate && (result.slower.length > 0 || failed > 0)) {
    const why = [result.slower.length > 0 ? `${result.slower.length} label(s) slower than the runs explain` : '', failed > 0 ? `${failed} request(s) failed` : '']
      .filter(Boolean)
      .join(', and ');
    console.error(`${String.fromCharCode(10)}Performance gate failed: ${why}.`);
    process.exitCode = 1;
  }
  return undefined;
}

function writeOut(root: string, out: string, report: string): void {
  const path = resolve(root, out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, report, 'utf8');
}

export function runPerf(cmd: PerfCommand): PerfResult | undefined {
  const root = resolve(cmd.root);

  // A JMeter results file is answered differently, and better: it carries every request rather
  // than six aggregates, so two runs are compared with a real test instead of a range check.
  if (/\.jtl$/i.test(cmd.summary)) return runJtl(root, cmd);
  const label = cmd.label ?? 'default';
  const { run, manual } = readPerfFile(resolve(root, cmd.summary));

  const all = storedRuns(root, label);
  const history = fromSameTool(all, run.source);
  if (all.length === 0) {
    const known = knownLabels(root);
    if (known.length > 0 && !known.includes(label)) {
      console.error(`[tewip] no recorded runs for label "${label}". This project has: ${known.join(', ')}.`);
    }
  }

  const comparisons = metricsInOrder(run)
    .map((metric) => compareMetric(metric, run.metrics[metric].value, baselineFor(history, metric)))
    // A metric that is zero now and was zero every time before says nothing, and printing
    // "0ms is within 0-0ms" three times buries the real lines.
    .filter((c) => c.now > 0 || c.baselineHigh > 0);

  const recorded = cmd.record === true;
  if (recorded) recordRun(root, label, run, cmd.gitSha);

  const breached = (run.thresholds ?? []).some((t) => t.breached);
  const poor = Object.values(run.metrics).some((m) => m.rating === 'poor');
  const regressed = comparisons.some((c) => c.direction === 'slower');
  const report = renderPerf(run, comparisons, label, history.length, recorded, manual);
  console.log(report);

  if (cmd.gate && (breached || regressed || poor)) {
    const why = [
      breached ? 'a threshold you wrote was breached' : '',
      poor ? "something is in Lighthouse's worst band" : '',
      regressed ? 'something is slower than the baselines explain' : '',
    ]
      .filter(Boolean)
      .join(', and ');
    console.error(`${String.fromCharCode(10)}Performance gate failed: ${why}.`);
    process.exitCode = 1;
  }

  if (cmd.out) {
    const path = resolve(root, cmd.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report, 'utf8');
  }

  return { run, comparisons, regressed, breached: breached || poor, report };
}
