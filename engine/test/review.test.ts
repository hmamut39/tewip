// The risk review. What is tested is the difference between knowing and guessing: a test that
// imports the changed code really covers it, a test that imports the package that exports it still
// reaches it, and a test that merely shares a word is marked as the guess it is.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { coverageFor, isCode, uncovered } from '../review/coverage.ts';
import { renderReview, reviewChange } from '../review/review.ts';
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
