// The risk review as a person reads it, before they read the diff.
//
// Split out of review.ts in Phase 219, when four corrections to this report took that file past
// the project's 300-line rule. review.ts decides what is true about the change; this decides what
// a reader is shown of it, which is where every defect that phase found actually lived.
import { relative, sep } from 'node:path';
import { renderExpectations } from './expectations.ts';
import { renderAgreements } from './agreements.ts';
import type { Review, TestRisk } from './review.ts';

/**
 * The first `limit` tests to show, with every covered file represented before any file gets a
 * second line.
 *
 * The list is ordered by how strongly each test knows the change, so cutting it at 15 cut by
 * strength - and on immich's five-file change that removed **every test covering one of the two
 * changed source files**. 24 tests covered the change; the 15 that import `config.dto.ts` sorted
 * first, and all nine touching `packages/sdk/src/fetch-client.ts` began at index 15. A reader saw
 * fifteen tests, all for the other file, and no indication that anything had been left out.
 *
 * Strength still decides the order within that, and what is left over still fills the rest.
 * Phase 219.
 */
function shown(tests: TestRisk[], limit: number): TestRisk[] {
  const picked = new Set<TestRisk>();
  const spokenFor = new Set<string>();
  for (const test of tests) {
    if (picked.size >= limit) break;
    if (test.covers.every((f) => spokenFor.has(f))) continue;
    picked.add(test);
    for (const f of test.covers) spokenFor.add(f);
  }
  for (const test of tests) {
    if (picked.size >= limit) break;
    picked.add(test);
  }
  // Back into the order they arrived in, so the strongest evidence still reads first.
  return tests.filter((t) => picked.has(t));
}

const when = (at: string): string => {
  if (!at) return 'never';
  const days = Math.round((Date.now() - Date.parse(at)) / 86_400_000);
  if (!Number.isFinite(days)) return 'once';
  return days <= 1 ? 'yesterday' : days < 14 ? `${days} days ago` : days < 60 ? `${Math.round(days / 7)} weeks ago` : `${Math.round(days / 30)} months ago`;
};

/** The review as a person reads it, before they read the diff. */
/**
 * The `cd` a suggested command needs, when the runner does not run from the repository root.
 *
 * A framework builds its commands relative to its own working directory, which in a layered
 * project is not where the report is read. `tewip review` printed
 * `node --test "test/flaky.test.ts"` for a file at engine/test/flaky.test.ts, and copying it gave
 * "Could not find 'test/flaky.test.ts'". The command is the one line in a review somebody acts on;
 * it has to work where they paste it.
 */
export function runFrom(root: string, cwd: string): string {
  const where = relative(root, cwd).split(sep).join('/');
  return where && where !== '.' ? `cd ${where} && ` : '';
}

export function renderReview(review: Review, runCommand?: (files: string[]) => string): string {
  const lines = [`# Risk review: ${review.range}`, '', `${review.files.length} changed file(s).`, ''];

  if (review.notes.length > 0) {
    lines.push('## Before you read the diff', '');
    for (const note of review.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  const renegotiated = renderExpectations(review.expectations);
  if (renegotiated.length > 0) lines.push(...renegotiated, '');
  const altered = renderAgreements(review.agreements);
  if (altered.length > 0) lines.push(...altered, '');

  lines.push('## Tests that cover this change', '');
  if (review.tests.length === 0) lines.push('None found.', '');
  for (const test of shown(review.tests, 15)) {
    // Silent on a project with no history: see `noHistory`.
    const past =
      test.flakedTimes + test.bugTimes > 0
        ? ` — failed before: ${test.bugTimes} real bug(s), ${test.flakedTimes} flaky, last ${when(test.lastFailed)}`
        : review.noHistory
          ? ''
          : ' — never failed in the history Tewip has kept';
    const how = test.how === 'imports' ? 'imports the changed code' : test.how === 'package' ? 'imports the package that exports it' : 'shares its words, so this one is a guess';
    lines.push(`- **${test.testFile}** (${how})${past}`);
    lines.push(`  - covers: ${test.covers.slice(0, 4).join(', ')}${test.covers.length > 4 ? `, +${test.covers.length - 4}` : ''}`);
  }
  if (review.tests.length > 15) lines.push(`- and ${review.tests.length - 15} more, not listed`);
  lines.push('');

  if (review.guessedAt.length > 0) {
    lines.push('## Changed, and only guessed at', '');
    lines.push(`No test imports ${review.guessedAt.length === 1 ? 'this file' : 'these files'}. What matched did so on a shared word, which this report calls a guess, so nothing above is evidence about ${review.guessedAt.length === 1 ? 'it' : 'them'}:`, '');
    for (const file of review.guessedAt.slice(0, 15)) lines.push(`- ${file}`);
    if (review.guessedAt.length > 15) lines.push(`- and ${review.guessedAt.length - 15} more`);
    lines.push('');
  }

  if (review.notRead.length > 0) {
    lines.push('## Changed, and not read', '');
    lines.push('Nothing reached these, and that is not a finding about them: following an import means finding `from x`, `import x` or `require(x)`, which this language does not write. A coverage report from the test run this project already does would answer it.', '');
    for (const file of review.notRead.slice(0, 15)) lines.push(`- ${file}`);
    if (review.notRead.length > 15) lines.push(`- and ${review.notRead.length - 15} more`);
    lines.push('');
  }

  if (review.uncovered.length > 0) {
    lines.push('## Changed, but nothing tests it', '');
    for (const file of review.uncovered.slice(0, 15)) lines.push(`- ${file}`);
    if (review.uncovered.length > 15) lines.push(`- and ${review.uncovered.length - 15} more`);
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

