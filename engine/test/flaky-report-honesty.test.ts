// `tewip flaky` is the one report in this project that offers to change your source files, so it is
// the one where a gap between what it shows and what it does costs the most.
//
// Found by reading the report it printed for WordPress/gutenberg: three headings naming a count
// above a shorter list, and, under five printed quarantine lines, the sentence "Only the named tests
// are touched" above a command that would have quarantined forty-eight. Forty-three tests would
// have stopped blocking CI without ever being named on screen.
//
// The third test here is the one worth keeping. `decide` refuses to quarantine a test whose failures
// looked like the application being wrong - but it reads that from the diagnosed category, so on
// undiagnosed history the rail cannot fire. All 48 of gutenberg's quarantine candidates were
// UNKNOWN. The verdict was sound; the report just never said which of the two it was.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notChecked, runFlaky } from '../flaky/flaky-command.ts';
import type { FlakyTest } from '../flaky/flaky.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);
const day = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

const test = (title: string, verdict: FlakyTest['verdict'], categories: Array<{ category: string; count: number }>): FlakyTest =>
  ({ testId: `cart > ${title}`, title, file: 'tests/cart.spec.ts', failedRuns: 4, totalRuns: 10, failedAttempts: 4, wastedMs: 1000, recoveredOnRetry: 2, branches: ['main', 'pr-1'], categories, firstSeen: day(9), lastSeen: day(1), verdict, why: '' }) as FlakyTest;

/** A project whose history has `n` tests that each failed and then passed on a retry. */
function project(n: number): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-flaky-'));
  const dir = join(root, '.tewip', 'history', 'proj');
  mkdirSync(dir, { recursive: true });
  const ids = Array.from({ length: n }, (_, i) => `cart > test ${i}`);
  // Ten runs, each running every test twice; failures recorded in three of them. That is a 30%
  // failure rate - under the threshold where a test counts as simply broken - with a passing retry
  // in every failing run, which is what `decide` reads as flakiness.
  const every = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const failed = [1, 2, 3];
  const runs: RunSummary[] = every.map((i) => ({ schemaVersion: 1, runId: `r${i}`, gitSha: '', branch: i === 1 ? 'main' : `pr-${i}`, startedAt: day(i), finishedAt: day(i), status: 'failed', attempts: Object.fromEntries(ids.map((id) => [id, 2])) }) as RunSummary);
  const records: TriageRecord[] = [];
  for (const id of ids) {
    for (const i of failed) {
      records.push({ schemaVersion: 1, testId: id, file: 'tests/cart.spec.ts', status: 'failed', errorMessage: '', errorStack: '', duration: 30_000, retry: 0, attachments: [], runId: `r${i}`, gitSha: '', timestamp: day(i), diagnosis: undefined } as unknown as TriageRecord);
    }
  }
  writeFileSync(join(dir, 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');
  writeFileSync(join(dir, 'triage.jsonl'), records.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');
  return root;
}

/** Runs the report and gives back everything it printed. */
async function report(root: string): Promise<string> {
  const said: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void said.push(args.map(String).join(' '));
  try {
    await runFlaky({ root, days: 30, apply: false });
  } finally {
    console.log = log;
  }
  return said.join(NL);
}

describe('the flaky report does not show less than it does', () => {
  it('says how many it left out when a group is longer than the list', async () => {
    const out = await report(project(20));
    const heading = out.match(/^### Quarantine these \((\d+)\)/m);
    assert.ok(heading, `no quarantine heading in:${NL}${out.slice(0, 400)}`);
    assert.equal(heading[1], '20', 'all 20 should be quarantine candidates');
    const listed = out.split(NL).filter((l) => /^- \*\*test \d+\*\*$/.test(l)).length;
    assert.equal(listed, 15, 'the group lists 15');
    assert.match(out, /Showing the 15 costliest\. The other 5 are not listed here\./);
  });

  it('tells you --apply quarantines all of them, not only the lines it printed', async () => {
    const out = await report(project(20));
    assert.match(out, /Showing 5 of 20\./);
    assert.match(out, /quarantines \*\*all 20\*\*, not only the 5 printed here/);
    // The sentence that was wrong: true of 5, printed above a command that acted on 20.
    assert.doesNotMatch(out, /Only the named tests are touched/, 'that promise is only honest when nothing was left out');
  });

  it('keeps the plain promise when nothing was left out', async () => {
    const out = await report(project(3));
    assert.match(out, /Only the named tests are touched/);
    assert.doesNotMatch(out, /Showing \d+ of \d+/);
    assert.doesNotMatch(out, /are not listed here/);
  });
});

describe('the flaky report names what it did not check', () => {
  it('says so when the rule against hiding a real bug could not fire', () => {
    const tests = [test('a', 'quarantine', [{ category: 'UNKNOWN', count: 4 }]), test('b', 'quarantine', [{ category: 'UNKNOWN', count: 4 }])];
    const out = notChecked(tests, 30).join(NL);
    assert.match(out, /\*\*2 of the 2 quarantine recommendation\(s\) rest on retry behaviour alone\.\*\*/);
    assert.match(out, /did not fire/);
    assert.match(out, /catching a race in the product/);
  });

  it('counts only the undiagnosed ones', () => {
    const tests = [
      test('a', 'quarantine', [{ category: 'UNKNOWN', count: 4 }]),
      test('b', 'quarantine', [{ category: 'TIMING', count: 4 }]),
      test('c', 'watch', [{ category: 'UNKNOWN', count: 4 }]),
    ];
    const out = notChecked(tests, 30).join(NL);
    assert.match(out, /\*\*1 of the 2 quarantine recommendation\(s\)/, 'the watched test is not a recommendation');
  });

  it('leaves the rail sentence out when every failure was diagnosed', () => {
    const out = notChecked([test('a', 'quarantine', [{ category: 'TIMING', count: 4 }])], 30).join(NL);
    assert.doesNotMatch(out, /rest on retry behaviour alone/);
    // The limits that hold whatever was diagnosed still have to be there.
    assert.match(out, /looks exactly like a suite with no flaky tests/);
    assert.match(out, /only thing covering what it covers/);
  });

  it('is in the report itself, not only in the function', async () => {
    const out = await report(project(3));
    assert.match(out, /^## What this did not check$/m);
  });
});
