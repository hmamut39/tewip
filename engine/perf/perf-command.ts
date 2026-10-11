// Phase 30: `tewip perf` - is this change slower, and does it matter?
//
// Two questions, answered separately because they fail separately:
//
//   1. **Did your own thresholds hold?** The team already wrote what "fast enough" means, in the k6
//      script. Tewip reads the result rather than asking them to write a budget twice. When the
//      export does not record thresholds - which the machine-readable one does not - the answer is
//      "this export cannot tell me", never "nothing was breached".
//   2. **Is it slower than it was?** Answered only from repeated baseline runs, and refused when
//      there are not enough of them, because one run against one run is not evidence.
//
// It never estimates a duration, a capacity or a user impact. It has no idea what the production
// hardware is, what the data volume is, or how many people use the endpoint, and a number invented
// for any of those is worse than silence.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MAIN_TIMING, readK6Summary, requestCount, type PerfRun } from './k6.ts';
import { compareMetric, ENOUGH_BASELINES, ENOUGH_REQUESTS, timingsToCompare, type Comparison } from './compare.ts';
import { baselineFor, knownLabels, recordRun, storedRuns } from './history.ts';

export interface PerfCommand {
  root: string;
  /** The k6 summary JSON to judge. */
  summary: string;
  /** Which suite this is, so two load tests are not each other's baseline. */
  label?: string;
  /** Add this run to the baseline. Deliberately explicit: see history.ts. */
  record?: boolean;
  out?: string;
  /** Exit non-zero on a breached threshold or a regression the baselines cannot explain. */
  gate?: boolean;
  gitSha?: string;
}

export interface PerfResult {
  run: PerfRun;
  comparisons: Comparison[];
  requests: number;
  regressed: boolean;
  breached: boolean;
  report: string;
}

const ms = (n: number): string => `${Math.round(n * 10) / 10}ms`;

export function renderPerf(
  run: PerfRun,
  comparisons: Comparison[],
  requests: number,
  label: string,
  baselineCount: number,
  recorded: boolean,
): string {
  const lines = ['# Tewip performance check', ''];
  const breaches = (run.thresholds ?? []).filter((t) => t.breached);
  const slower = comparisons.filter((c) => c.direction === 'slower');
  const faster = comparisons.filter((c) => c.direction === 'faster');
  const unsure = comparisons.filter((c) => c.direction === 'cannot-say');

  lines.push(`Read a k6 run of **${requests} requests**, compared against **${baselineCount}** recorded baseline ${baselineCount === 1 ? 'run' : 'runs'} for \`${label}\`.`, '');

  // Headline, in the order that decides what a person does next.
  if (breaches.length > 0) {
    lines.push(`**${breaches.length} of your own thresholds ${breaches.length === 1 ? 'was' : 'were'} breached.**`, '');
  }
  if (slower.length > 0) lines.push(`**${slower.length} ${slower.length === 1 ? 'metric is' : 'metrics are'} slower than the baseline runs can explain.**`, '');
  if (breaches.length === 0 && slower.length === 0) {
    lines.push(
      run.thresholds === null
        ? '**No regression this baseline can detect.** Your thresholds are not in this export, so nothing is said about them.'
        : '**No threshold breached, and no regression this baseline can detect.**',
      '',
    );
  }

  lines.push('## Did your own thresholds hold?', '');
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
    for (const t of run.thresholds) {
      lines.push(`- ${t.breached ? '**breached**' : 'held'} — \`${t.metric}\`: \`${t.expression}\``);
    }
    lines.push('');
  }

  lines.push('## Is it slower than it was?', '');
  if (baselineCount < ENOUGH_BASELINES) {
    lines.push(
      `**Cannot say.** There ${baselineCount === 1 ? 'is' : 'are'} ${baselineCount} recorded ${baselineCount === 1 ? 'run' : 'runs'} for \`${label}\`, ` +
        `and Tewip needs ${ENOUGH_BASELINES} before it will call anything a regression. Performance numbers move between identical ` +
        'runs, and without several of them there is no way to tell a change from the machine having a busy moment. ' +
        `Record baselines on your main branch with \`tewip perf <summary.json> --record\`.`,
      '',
    );
  }
  for (const c of [...slower, ...faster, ...unsure]) {
    const verdict = c.direction === 'slower' ? '**slower**' : c.direction === 'faster' ? 'faster' : 'cannot say';
    lines.push(`- \`${c.metric}\` p95 ${ms(c.now)} — ${verdict}`);
    lines.push(`  - baseline ${ms(c.baselineLow)}–${ms(c.baselineHigh)} over ${c.baselineRuns} runs, middle ${ms(c.before)}`);
    lines.push(`  - ${c.why}`);
  }
  lines.push('');

  if (requests < ENOUGH_REQUESTS) {
    lines.push(
      `**${requests} requests is thin.** A p95 from this few is a handful of data points and will move on its own. ` +
        'Treat everything above as indicative and lengthen the run before deciding anything.',
      '',
    );
  }

  lines.push('## What this does not tell you', '');
  lines.push(
    '- **Nothing about production.** This is the hardware the run happened on, with that data volume and that ' +
      'concurrency. Tewip cannot see your real machines, your real data or your real traffic, and will not guess.',
    '- **No duration is predicted.** How long a real user waits depends on network, device and cache, none of which are here.',
    '- **Only what the script exercised.** An endpoint the test never called is not covered, however green this looks.',
    '- **Not capacity.** This says whether it changed, not how many users it would hold.',
    '',
  );

  if (recorded) lines.push(`This run was added to the baseline for \`${label}\`.`, '');
  else lines.push(`This run was **not** recorded. Add \`--record\` on your main branch to make it part of the baseline; a regression recorded by accident becomes next week's normal.`, '');

  return lines.join('\n');
}

export function runPerf(cmd: PerfCommand): PerfResult {
  const root = resolve(cmd.root);
  const label = cmd.label ?? 'default';
  const run = readK6Summary(resolve(root, cmd.summary));
  const requests = requestCount(run);

  const history = storedRuns(root, label);
  if (history.length === 0) {
    const known = knownLabels(root);
    // A typo in --label would otherwise look exactly like "no history yet", and the team would
    // record a second baseline under the wrong name without noticing.
    if (known.length > 0 && !known.includes(label)) {
      console.error(`[tewip] no recorded runs for label "${label}". This project has: ${known.join(', ')}.`);
    }
  }

  const comparisons = timingsToCompare(run)
    .map((metric) => compareMetric(metric, run.timings[metric].p95, baselineFor(history, metric)))
    // A metric that is zero now and was zero every time before says nothing. http_req_blocked is
    // zero on a local run, and printing "0ms is within 0-0ms" three times buries the real lines.
    .filter((c) => c.now > 0 || c.baselineHigh > 0);

  const recorded = cmd.record === true;
  if (recorded) recordRun(root, label, run, requests, cmd.gitSha);

  const breached = (run.thresholds ?? []).some((t) => t.breached);
  const regressed = comparisons.some((c) => c.direction === 'slower');
  const report = renderPerf(run, comparisons, requests, label, history.length, recorded);
  console.log(report);

  if (cmd.gate && (breached || regressed)) {
    const why = [breached ? 'a threshold you wrote was breached' : '', regressed ? 'something is slower than the baselines explain' : '']
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

  return { run, comparisons, requests, regressed, breached, report };
}
