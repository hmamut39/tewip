// `tewip flaky`: the Monday morning answer. Which tests are wasting the team's time, how much, and
// what to do about each one - read from the runs Tewip already diagnosed, so it costs nothing and
// cannot re-judge an old failure with today's rules.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { datasetFiles, readRunSummaries, readTriageRecords } from '../../reporters/store.ts';
import { flakyTests, readyToRelease, weeklyCost, type FlakyTest } from './flaky.ts';
import { applyQuarantine, frameworkOf, quarantineFor } from './quarantine.ts';
import { loadVerdicts, saidByAPerson, verdictFor } from '../learn/verdicts.ts';

export interface FlakyCommand {
  root: string;
  /** Which kept project to read; without it, every project Tewip has history for. */
  name?: string;
  days: number;
  /** Put the quarantine line into the test files, instead of only printing it. */
  apply: boolean;
  out?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many tests each group lists, and how many quarantine lines are written out in full. */
const SHOW = 15;
const SHOW_LINES = 5;
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} CI min`;

function projects(root: string, only?: string): string[] {
  const dir = join(root, '.tewip', 'history');
  if (only) return [only];
  return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, 'triage.jsonl'))) : [];
}

/** The test file on disk, when the report's path still exists in this project. */
function testFile(root: string, test: FlakyTest): string | null {
  const direct = resolve(root, test.file);
  return test.file && existsSync(direct) ? direct : null;
}

export async function runFlaky(cmd: FlakyCommand): Promise<FlakyTest[]> {
  const names = projects(cmd.root, cmd.name);
  if (names.length === 0) {
    throw new Error(`no history in ${join(cmd.root, '.tewip', 'history')}. Run \`tewip explain\` or \`tewip report\` on a few runs first: this is read from what those kept.`);
  }
  const since = new Date(Date.now() - cmd.days * DAY_MS).toISOString();
  const all: FlakyTest[] = [];
  const lines: string[] = ['# Flaky tests', '', `The last ${cmd.days} days, from runs Tewip already diagnosed. No tests were run and no model was called.`, ''];

  for (const name of names) {
    const history = datasetFiles(join(cmd.root, '.tewip', 'history', name));
    const records = readTriageRecords(history.triage);
    const runs = readRunSummaries(history.runs);
    const computed = flakyTests(records, runs, { since });
    // What a person already decided about a test wins over what Tewip works out, and is shown as
    // theirs: the argument is had once, not every Monday.
    const corrections = loadVerdicts(cmd.root);
    const tests = computed.map((test) => {
      const said = verdictFor('flaky', test.title, corrections) ?? verdictFor('flaky', test.testId, corrections);
      return said ? { ...test, verdict: said.verdict as typeof test.verdict, why: `${saidByAPerson(said)} (Tewip had said ${test.verdict})` } : test;
    });
    if (tests.length === 0) continue;
    all.push(...tests);

    const cost = weeklyCost(tests, cmd.days);
    lines.push(`## ${name}`, '', `${tests.length} test(s) failed at least once. About ${cost.minutes} CI minute(s) and ${cost.attempts} failed attempt(s) a week.`, '');

    const group = (verdict: FlakyTest['verdict'], title: string, explain: string) => {
      const chosen = tests.filter((t) => t.verdict === verdict);
      if (chosen.length === 0) return;
      lines.push(`### ${title} (${chosen.length})`, '', explain, '');
      for (const test of chosen.slice(0, SHOW)) {
        lines.push(`- **${test.title}**`);
        lines.push(`  - ${test.failedRuns} of ${test.totalRuns} run(s), ${test.failedAttempts} failed attempt(s), ${minutes(test.wastedMs)} lost${test.recoveredOnRetry > 0 ? `, passed on a retry ${test.recoveredOnRetry} time(s)` : ''}`);
        lines.push(`  - Tewip read them as: ${test.categories.map((c) => `${c.category} ×${c.count}`).join(', ')}`);
        lines.push(`  - Why: ${test.why}`);
        if (test.file) lines.push(`  - Where: ${test.file}`);
      }
      // A heading that says 48 above a list of 15 is the defect this project keeps finding in
      // itself: a true number beside a shorter answer, with nothing saying they differ.
      if (chosen.length > SHOW) lines.push(`_Showing the ${SHOW} costliest. The other ${chosen.length - SHOW} are not listed here._`);
      lines.push('');
    };

    group('quarantine', 'Quarantine these', 'Unreliable rather than wrong. Stop them blocking everyone, then fix them on purpose.');
    group('fix-now', 'Fix these, do not hide them', 'Hiding one of these would hide something real.');
    group('watch', 'Watch', 'Not enough evidence yet to act.');

    // Coming back out is the half nobody ever does.
    const quarantined = readQuarantined(cmd.root);
    const back = readyToRelease(quarantined, records, runs, since);
    if (back.length > 0) {
      lines.push('### Ready to come out of quarantine', '', 'These ran in this period and did not fail once.', '');
      for (const testId of back) lines.push(`- ${testId.split(' > ').at(-1)} — take its quarantine line out and let it block again.`);
      lines.push('');
    }
  }

  if (all.length === 0) {
    console.log(`Nothing failed in the last ${cmd.days} days. Try --days 30.`);
    return [];
  }

  const toQuarantine = all.filter((t) => t.verdict === 'quarantine');
  if (cmd.apply && toQuarantine.length > 0) lines.push(...applyAll(cmd.root, toQuarantine));
  else if (toQuarantine.length > 0) lines.push(...suggest(cmd.root, toQuarantine));

  lines.push(...notChecked(all, cmd.days));

  const report = lines.join('\n');
  console.log(report);
  if (cmd.out) {
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
    console.log(`\nWritten to ${cmd.out}`);
  }
  return all;
}

/** Tests already carrying Tewip's quarantine line, found by reading the test files it knows about. */
function readQuarantined(root: string): string[] {
  const file = join(root, '.tewip', 'quarantined.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

function suggest(root: string, tests: FlakyTest[]): string[] {
  const lines = ['### The line to add', ''];
  for (const test of tests.slice(0, SHOW_LINES)) {
    const path = testFile(root, test);
    const framework = path ? frameworkOf(path, readFileSync(path, 'utf8')) : null;
    if (!path || !framework) {
      lines.push(`- ${test.title}: ${test.file || 'file not found in this project'} - quarantine it the way this project does.`);
      continue;
    }
    lines.push(`- ${test.title} (${test.file}):`, '```', quarantineFor(test, framework).line, '```');
  }
  const shown = Math.min(tests.length, SHOW_LINES);
  lines.push(
    '',
    shown < tests.length
      ? `Showing ${shown} of ${tests.length}. \`tewip flaky --apply\` quarantines **all ${tests.length}**, not only the ${shown} printed here - each with its own evidence written above it. No test outside those ${tests.length} is touched.`
      : 'Run `tewip flaky --apply` to put these lines in, each with the evidence above it. Only the named tests are touched.',
    '',
  );
  return lines;
}

/** Writes the quarantine into the test files, and remembers which tests were quarantined. */
function applyAll(root: string, tests: FlakyTest[]): string[] {
  const lines = ['### Applied', ''];
  const done: string[] = [];
  for (const test of tests) {
    const path = testFile(root, test);
    if (!path) {
      lines.push(`- ${test.title}: not applied, ${test.file || 'no file'} is not in this project`);
      continue;
    }
    const source = readFileSync(path, 'utf8');
    const framework = frameworkOf(path, source);
    if (!framework) {
      lines.push(`- ${test.title}: not applied, the framework of ${test.file} was not recognised`);
      continue;
    }
    const changed = applyQuarantine(source, test, framework);
    if (!changed) {
      lines.push(`- ${test.title}: not applied, the test was not found in ${test.file} (was it renamed?)`);
      continue;
    }
    if (changed === source) {
      lines.push(`- ${test.title}: already quarantined`);
      done.push(test.testId);
      continue;
    }
    writeFileSync(path, changed, 'utf8');
    done.push(test.testId);
    lines.push(`- ${test.title}: quarantined in ${test.file}`);
  }
  if (done.length > 0) {
    const file = join(root, '.tewip', 'quarantined.txt');
    const before = readQuarantined(root);
    writeFileSync(file, [...new Set([...before, ...done])].join('\n') + '\n', 'utf8');
    lines.push('', `Remembered in ${join('.tewip', 'quarantined.txt')}, so Tewip can tell you when each one is safe to bring back.`);
  }
  lines.push('', 'Nothing else in those files was changed. Review the diff before committing: a quarantined test is a decision, not a fix.', '');
  return lines;
}

/**
 * What this report did not check.
 *
 * The quarantine rules in `decide` carry a rail: a test whose failures Tewip read as the
 * application being wrong is never quarantined, because hiding it would hide the bug. That rail
 * reads the diagnosed category of each failure - so on history where nothing has been diagnosed it
 * has nothing to read and cannot fire, and the verdict rests on retry behaviour alone. On real
 * history that is the normal case rather than the exception: of the 15 quarantine candidates this
 * printed for WordPress/gutenberg, all 15 were UNKNOWN - every one. The recommendation is still the
 * best reading of the evidence there is. What was missing was the sentence telling the person which
 * of the two they were being shown.
 */
export function notChecked(tests: FlakyTest[], days: number): string[] {
  const quarantine = tests.filter((t) => t.verdict === 'quarantine');
  const undiagnosed = quarantine.filter((t) => t.categories.every((c) => c.category === 'UNKNOWN'));
  const lines = ['## What this did not check', ''];
  lines.push(`- Any test that did not fail, and any run nobody put through \`tewip explain\` or \`tewip report\`. These numbers are read from kept history of the last ${days} day(s), and a suite nobody recorded looks exactly like a suite with no flaky tests.`);
  if (undiagnosed.length > 0) {
    lines.push(
      `- **${undiagnosed.length} of the ${quarantine.length} quarantine recommendation(s) rest on retry behaviour alone.** None of those failures had been diagnosed, so the rule that refuses to quarantine a test whose failures looked like the application being wrong had nothing to read and did not fire. A test that fails and then passes on a retry can also be a test correctly catching a race in the product - quarantine that one and the race is what you hide. Running \`tewip explain\` over those runs is what tells the two apart.`,
    );
  }
  lines.push('- Whether a test is the only thing covering what it covers. Tewip does not know what stops being tested when you quarantine it.');
  lines.push('- Whether a test is the same test. These are matched by name, so a renamed test looks like a new one and its history stays behind with the old name.');
  lines.push('');
  return lines;
}
