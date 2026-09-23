// The risk review of a change, from what Tewip already knows about this project.
//
// A general coding agent can read a diff. What it cannot do is tell you that the two tests covering
// your change have flaked eleven times this month, that this area has had three real bugs since
// August, and that nothing at all covers the file you edited. That comes from Tewip's own history,
// which is why this costs nothing and why nothing else can produce it.
import { componentOf } from '../../outlets/items.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import type { TestCoverage } from './coverage.ts';

export interface TestRisk {
  testFile: string;
  how: TestCoverage['how'];
  covers: string[];
  /** How often this test has failed before, and what Tewip decided it was. */
  flakedTimes: number;
  bugTimes: number;
  /** The most recent time it failed, so "last week" and "in March" read differently. */
  lastFailed: string;
}

export interface AreaRisk {
  area: string;
  failures: number;
  realBugs: number;
  flaky: number;
  /** Changed files in this area. */
  files: string[];
}

export interface Review {
  range: string;
  files: string[];
  tests: TestRisk[];
  uncovered: string[];
  areas: AreaRisk[];
  /** Tests worth running first, most telling first. */
  runFirst: string[];
  /** What a person should know before reading the diff, in plain sentences. */
  notes: string[];
}

const fileOf = (record: TriageRecord): string => record.file ?? '';
const countBy = <T>(xs: T[], key: (x: T) => string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const x of xs) out.set(key(x), (out.get(key(x)) ?? 0) + 1);
  return out;
};

/** The review, assembled from the change, what covers it, and what has gone wrong here before. */
export function reviewChange(range: string, changed: string[], coverage: TestCoverage[], history: TriageRecord[], notCovered: string[]): Review {
  const byFile = new Map<string, TriageRecord[]>();
  for (const record of history) {
    const file = fileOf(record).split('\\').join('/');
    if (!file) continue;
    byFile.set(file, [...(byFile.get(file) ?? []), record]);
  }

  const tests: TestRisk[] = coverage.map((c) => {
    const past = byFile.get(c.testFile) ?? [];
    const kinds = countBy(past, (r) => r.diagnosis?.category ?? 'UNKNOWN');
    return {
      testFile: c.testFile,
      how: c.how,
      covers: c.covers,
      flakedTimes: kinds.get('TIMING') ?? 0,
      bugTimes: kinds.get('REAL_BUG') ?? 0,
      lastFailed: past.map((r) => r.timestamp).sort().at(-1) ?? '',
    };
  });

  // The areas a change touches, and what has broken in them before.
  const areaOf = (file: string) => componentOf(file);
  const areas = new Map<string, AreaRisk>();
  for (const file of changed) {
    const area = areaOf(file);
    const found = areas.get(area) ?? { area, failures: 0, realBugs: 0, flaky: 0, files: [] };
    found.files.push(file);
    areas.set(area, found);
  }
  for (const record of history) {
    const area = areaOf(fileOf(record));
    const found = areas.get(area);
    if (!found) continue;
    found.failures++;
    if (record.diagnosis?.category === 'REAL_BUG') found.realBugs++;
    if (record.diagnosis?.category === 'TIMING') found.flaky++;
  }

  // What to run first: what really imports the change, worst history first - a test that has caught
  // a real bug here before is the one most worth running now.
  const runFirst = [...tests]
    .filter((t) => t.how !== 'name')
    .sort((a, b) => b.bugTimes - a.bugTimes || a.flakedTimes - b.flakedTimes)
    .slice(0, 10)
    .map((t) => t.testFile);

  const notes: string[] = [];
  const flaky = tests.filter((t) => t.flakedTimes >= 3);
  if (flaky.length > 0) {
    notes.push(
      `${flaky.length} of the tests covering this change have flaked before (${flaky.map((t) => `${t.testFile.split('/').at(-1)} ×${t.flakedTimes}`).join(', ')}). If one of them goes red, check Tewip's diagnosis before blaming the change.`,
    );
  }
  if (notCovered.length > 0) {
    notes.push(`${notCovered.length} changed file(s) have no test that imports them: ${notCovered.slice(0, 5).join(', ')}${notCovered.length > 5 ? ', ...' : ''}. A mistake there would reach production unnoticed.`);
  }
  const risky = [...areas.values()].filter((a) => a.realBugs >= 2).sort((a, b) => b.realBugs - a.realBugs);
  if (risky.length > 0) {
    notes.push(`${risky[0].area} has had ${risky[0].realBugs} real bug(s) in the history Tewip has kept. It is the part of this change worth a second pair of eyes.`);
  }
  if (tests.length === 0 && changed.length > 0) {
    notes.push('No test in this project reaches any of the changed files. Tewip can write one: `tewip plan "<what the change should do>"` then `tewip write`.');
  }

  return { range, files: changed, tests, uncovered: notCovered, areas: [...areas.values()].sort((a, b) => b.realBugs - a.realBugs || b.failures - a.failures), runFirst, notes };
}

const when = (at: string): string => {
  if (!at) return 'never';
  const days = Math.round((Date.now() - Date.parse(at)) / 86_400_000);
  if (!Number.isFinite(days)) return 'once';
  return days <= 1 ? 'yesterday' : days < 14 ? `${days} days ago` : days < 60 ? `${Math.round(days / 7)} weeks ago` : `${Math.round(days / 30)} months ago`;
};

/** The review as a person reads it, before they read the diff. */
export function renderReview(review: Review, runCommand?: (files: string[]) => string): string {
  const lines = [`# Risk review: ${review.range}`, '', `${review.files.length} changed file(s).`, ''];

  if (review.notes.length > 0) {
    lines.push('## Before you read the diff', '');
    for (const note of review.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## Tests that cover this change', '');
  if (review.tests.length === 0) lines.push('None found.', '');
  for (const test of review.tests.slice(0, 15)) {
    const past = test.flakedTimes + test.bugTimes > 0 ? ` — failed before: ${test.bugTimes} real bug(s), ${test.flakedTimes} flaky, last ${when(test.lastFailed)}` : ' — never failed in the history Tewip has kept';
    const how = test.how === 'imports' ? 'imports the changed code' : test.how === 'package' ? 'imports the package that exports it' : 'shares its words, so this one is a guess';
    lines.push(`- **${test.testFile}** (${how})${past}`);
    lines.push(`  - covers: ${test.covers.slice(0, 4).join(', ')}${test.covers.length > 4 ? `, +${test.covers.length - 4}` : ''}`);
  }
  lines.push('');

  if (review.uncovered.length > 0) {
    lines.push('## Changed, but nothing tests it', '');
    for (const file of review.uncovered.slice(0, 15)) lines.push(`- ${file}`);
    lines.push('');
  }

  if (review.areas.some((a) => a.failures > 0)) {
    lines.push('## What has gone wrong here before', '');
    for (const area of review.areas.filter((a) => a.failures > 0).slice(0, 6)) {
      lines.push(`- **${area.area}**: ${area.failures} failure(s) — ${area.realBugs} real bug(s), ${area.flaky} flaky`);
    }
    lines.push('');
  }

  if (review.runFirst.length > 0) {
    lines.push('## Run these first', '');
    lines.push(runCommand ? '```' : '', runCommand ? runCommand(review.runFirst) : review.runFirst.map((f) => `- ${f}`).join('\n'), runCommand ? '```' : '');
    lines.push('');
  }

  lines.push('---', '', 'Read from this project\'s own failure history. No model was called, so this cost nothing.');
  return lines.join('\n');
}
