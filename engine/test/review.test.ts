// The risk review. What is tested is the difference between knowing and guessing: a test that
// imports the changed code really covers it, a test that imports the package that exports it still
// reaches it, and a test that merely shares a word is marked as the guess it is.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { coverageFor, isCode, isCoverableCode, uncovered } from '../review/coverage.ts';
import { renderReview, reviewChange, runFrom } from '../review/review.ts';
import type { TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);

function project(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-review-'));
  for (const [name, lines] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, lines.join(NL), 'utf8');
  }
  return root;
}

const failure = (file: string, category: string, at: string): TriageRecord =>
  ({ schemaVersion: 1, testId: `x > ${file}`, file, status: 'failed', errorMessage: '', errorStack: '', duration: 1000, retry: 0, attachments: [], runId: 'r', gitSha: '', timestamp: at, diagnosis: { category } }) as unknown as TriageRecord;

describe('which tests reach a change', () => {
  it('knows a test that imports the changed file', () => {
    const root = project({
      'src/cart.ts': ['export const total = () => 0;'],
      'test/cart.test.ts': ["import { total } from '../src/cart.ts';", "it('adds', () => total());"],
      'test/other.test.ts': ["it('unrelated', () => {});"],
    });
    const coverage = coverageFor(root, ['src/cart.ts']);
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0].testFile, 'test/cart.test.ts');
    assert.equal(coverage[0].how, 'imports');
  });

  it('follows the package front door, which is how most libraries are tested', () => {
    // From a real measurement: eight of sixteen real commits were missed before this, because every
    // test imports "../src" and nothing imports "../src/utils.ts".
    const root = project({
      'src/index.ts': ['export * from "./utils.ts";', 'export * from "./query.ts";'],
      'src/utils.ts': ['export const withBase = (a: string) => a;'],
      'src/query.ts': ['export const parseQuery = (s: string) => ({});'],
      'test/utilities.test.ts': ['import { withBase } from "../src";', 'it("withBase", () => withBase("/"));'],
    });
    const coverage = coverageFor(root, ['src/utils.ts']);
    assert.equal(coverage[0].testFile, 'test/utilities.test.ts');
    assert.equal(coverage[0].how, 'package', 'it reaches the code, but not by naming the file');
  });

  it('marks a word match as a guess, and never above a real import', () => {
    // Two shared words at least: one word in common is a coincidence, not a clue.
    const root = project({
      'src/checkout-payment.ts': ['export const pay = () => 0;'],
      'test/checkout-payment-flow.test.ts': ['it("checkout payment happens once", () => {});'],
      'test/unrelated.test.ts': ['it("something else", () => {});'],
    });
    const coverage = coverageFor(root, ['src/checkout-payment.ts']);
    assert.equal(coverage.length, 1, 'only the one whose words really overlap');
    assert.equal(coverage[0].how, 'name');
  });

  it('leaves documentation and lockfiles out of it', () => {
    assert.equal(isCode('src/cart.ts'), true);
    assert.equal(isCode('README.md'), false);
    assert.equal(isCode('package-lock.json'), false);
    const root = project({ 'src/cart.ts': ['export const x = 1;'] });
    assert.deepEqual(uncovered(['src/cart.ts', 'ROADMAP.md'], []), ['src/cart.ts'], 'nobody tests a roadmap');
  });
});

describe('what the history adds', () => {
  const coverage = [
    { testFile: 'test/cart.test.ts', covers: ['src/cart.ts'], how: 'imports' as const },
    { testFile: 'test/slow.test.ts', covers: ['src/cart.ts'], how: 'imports' as const },
  ];
  const history = [
    failure('test/slow.test.ts', 'TIMING', '2026-09-01T00:00:00Z'),
    failure('test/slow.test.ts', 'TIMING', '2026-09-02T00:00:00Z'),
    failure('test/slow.test.ts', 'TIMING', '2026-09-03T00:00:00Z'),
    failure('test/cart.test.ts', 'REAL_BUG', '2026-09-04T00:00:00Z'),
  ];

  it('warns that a covering test has flaked, so a red run is not blamed on the change', () => {
    const review = reviewChange('main...HEAD', ['src/cart.ts'], coverage, history, []);
    assert.match(review.notes.join(' '), /have flaked before/);
    assert.match(review.notes.join(' '), /slow\.test\.ts ×3/);
    assert.match(review.notes.join(' '), /check Tewip's diagnosis before blaming the change/);
  });

  it('puts the test that has caught a real bug here first', () => {
    const review = reviewChange('main...HEAD', ['src/cart.ts'], coverage, history, []);
    assert.equal(review.runFirst[0], 'test/cart.test.ts');
  });

  it('says plainly when nothing covers a changed file', () => {
    const review = reviewChange('main...HEAD', ['src/new.ts'], [], [], ['src/new.ts']);
    assert.match(review.notes.join(' '), /no test that imports them/);
    assert.match(review.notes.join(' '), /would reach production unnoticed/);
    assert.match(renderReview(review), /## Changed, but nothing tests it/);
  });

  it('offers to write the missing test rather than only complaining', () => {
    const review = reviewChange('main...HEAD', ['src/new.ts'], [], [], []);
    assert.match(review.notes.join(' '), /tewip plan/);
  });

  it('reads as a report a person can act on', () => {
    const review = reviewChange('main...HEAD', ['src/cart.ts'], coverage, history, []);
    const text = renderReview(review, (files) => `npx vitest run ${files.join(' ')}`);
    assert.match(text, /# Risk review: main\.\.\.HEAD/);
    assert.match(text, /imports the changed code/);
    assert.match(text, /npx vitest run test\/cart\.test\.ts/);
    assert.match(text, /No model was called, so this cost nothing/);
  });
});

// Phase 62: what `review` claimed covered a real change to extensions/vscode/engine-version.js.
//
// Eleven test files - a2a, junit, perf, schema, write, web-scan and five more, none of which has
// anything to do with the editor extension. Two shared words were required and two were always
// found: *engine*, because every test in this repository lives in `engine/test/`, and *version*,
// because fixtures everywhere say `schemaVersion: 1`. Fourteen of the fifteen entries in that
// section were guesses and eleven were the same wrong guess - in the headline section of the
// command. A section that is mostly noise is a section a reviewer learns to skip.
describe('a word match that is really a coincidence', () => {
  it('does not treat a word most tests contain as evidence about any of them', () => {
    const many: Record<string, string[]> = {
      'engine/thing-version.ts': ['export const thing = () => 0;'],
    };
    // Eight tests that all mention "version" and all sit under engine/, like the real repository.
    for (let i = 0; i < 8; i += 1) {
      many[`engine/test/area${i}.test.ts`] = [`it("area${i} keeps schemaVersion", () => { const schemaVersion = 1; });`];
    }
    const coverage = coverageFor(project(many), ['engine/thing-version.ts']);
    assert.deepEqual(coverage, [], 'a word in every test file says nothing about any of them');
  });

  it('still makes the guess when the shared words are the file\'s own and rare', () => {
    const root = project({
      'src/checkout-payment.ts': ['export const pay = () => 0;'],
      'test/checkout-payment-flow.test.ts': ['it("checkout payment happens once", () => {});'],
      'test/unrelated.test.ts': ['it("something else", () => {});'],
      'test/also-unrelated.test.ts': ['it("nothing to do with it", () => {});'],
    });
    const coverage = coverageFor(root, ['src/checkout-payment.ts']);
    assert.equal(coverage.length, 1, 'the one whose words really are the changed file\'s');
    assert.equal(coverage[0].how, 'name');
  });

  it('will not match on the folder a change happens to live in', () => {
    // "engine" was in the path of every test, so it counted towards the two words required.
    const root = project({
      'engine/widgets/pump.ts': ['export const pump = () => 0;'],
      'engine/test/engine-widgets-other.test.ts': ['it("engine widgets do something else", () => {});'],
    });
    assert.deepEqual(coverageFor(root, ['engine/widgets/pump.ts']), [], 'sharing a directory name is not sharing a subject');
  });

  it('never asks whether a test file or a declaration file is covered', () => {
    // A changed test is its own test, and a .d.ts executes nothing. `version-compare.d.ts` was
    // matched to `perf.test.ts` because both say "version" and "compare" - not wrong by the rule,
    // but a question that should never have been asked.
    assert.equal(isCoverableCode('src/cart.ts'), true);
    assert.equal(isCoverableCode('src/types.d.ts'), false);
    assert.equal(isCoverableCode('engine/test/cart.test.ts'), false);
    assert.equal(isCoverableCode('tests/test_cart.py'), false);
    assert.equal(isCode('src/types.d.ts'), true, 'it is still code for every other purpose');
  });

  it('does not demand a test for a file that executes nothing', () => {
    // "version-compare.d.ts has no test that imports it. A mistake there would reach production
    // unnoticed" is a demand the reader cannot act on.
    assert.deepEqual(uncovered(['src/types.d.ts', 'src/cart.ts'], []), ['src/cart.ts']);
  });
});

describe('the command a review tells you to run', () => {
  // It is the one line in the report somebody acts on. `tewip review` printed
  // `node --test "test/flaky.test.ts"` for a file at engine/test/flaky.test.ts, because the runner
  // builds paths relative to its own working directory and the report is read from the repository
  // root. Pasting it gave "Could not find 'test/flaky.test.ts'".
  it('says where to run it when the runner lives in a subdirectory', () => {
    assert.equal(runFrom('/repo', '/repo/engine'), 'cd engine && ');
    assert.equal(runFrom('/repo', '/repo/packages/api'), 'cd packages/api && ');
  });

  it('says nothing when the runner is the repository root', () => {
    assert.equal(runFrom('/repo', '/repo'), '');
  });

  it('uses forward slashes whatever the platform gave it', () => {
    // A command is pasted into a shell, and a Windows path separator is not one.
    const prefix = runFrom(join('/repo'), join('/repo', 'engine', 'sub'));
    assert.equal(prefix.includes(String.fromCharCode(92)), false, prefix);
    assert.match(prefix, /^cd engine\/sub && $/);
  });
});
