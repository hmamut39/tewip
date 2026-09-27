// Phase 22, where it actually earns its place: the tests a change touched, in the review and in the
// evidence bundle.
//
// Two properties are worth protecting here. It must stay silent when every test in the change can
// fail, because a section that appears on every pull request to say "all fine" is one people learn
// to scroll past - and then miss the day it says something. And a green run containing a test that
// cannot fail must not read as a clean bill of health, which is the overclaim this whole phase
// exists to prevent.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attestRun, renderAttestation } from '../attest/attest.ts';
import { prCommentBody } from '../../ci/publish.ts';
import type { CiContext } from '../../ci/context.ts';
import { changedTestLines, vouchChanged } from '../vouch/changed.ts';
import type { RunSummary } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);

/** A checkout with the given files in it. */
function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-changed-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return root;
}

const green = `it('adds up the lines', () => {${NL}  expect(total([2, 3])).toBe(5);${NL}});`;
const unfinished = `it('rejects an expired code', () => {${NL}  expect(cart.errors);${NL}});`;
const noValue = `it('applies a discount', () => {${NL}  const cart = build();${NL}  cart.apply('SAVE10');${NL}});`;

describe('the tests a change touched', () => {
  it('says nothing at all when every test in the change can fail', () => {
    const root = checkout({ 'tests/cart.test.js': green, 'src/cart.js': 'export const total = () => 5;' });
    const seen = vouchChanged(root, ['tests/cart.test.js', 'src/cart.js']);
    assert.equal(seen.read, 1);
    assert.deepEqual(seen.cannotFail, []);
    assert.deepEqual(changedTestLines(seen), [], 'a section that always appears is a section nobody reads');
  });

  it('names the test that cannot fail, and quotes the line', () => {
    const root = checkout({ 'tests/cart.test.js': `${green}${NL}${NL}${unfinished}` });
    const lines = changedTestLines(vouchChanged(root, ['tests/cart.test.js'])).join(NL);
    assert.match(lines, /cannot fail \(1 of 2\)/);
    assert.match(lines, /rejects an expired code/);
    assert.match(lines, /expect\(cart\.errors\);/);
    assert.doesNotMatch(lines, /adds up the lines/, 'the sound test is not listed');
  });

  it('keeps a test that compares no value apart from one that cannot fail', () => {
    const root = checkout({ 'tests/cart.test.js': `${green}${NL}${NL}${noValue}` });
    const seen = vouchChanged(root, ['tests/cart.test.js']);
    assert.deepEqual(seen.cannotFail, []);
    assert.equal(seen.crashOnly.length, 1);
    const lines = changedTestLines(seen).join(NL);
    assert.match(lines, /compare no value/);
    assert.match(lines, /Sometimes that is the intention/);
  });

  it('passes over a file the change deleted, rather than failing on it', () => {
    const root = checkout({ 'tests/cart.test.js': green });
    const seen = vouchChanged(root, ['tests/cart.test.js', 'tests/gone.test.js']);
    assert.equal(seen.files, 1);
  });
});

const run = (): RunSummary =>
  ({ schemaVersion: 1, runId: 'run-9', gitSha: 'abc1234', startedAt: '2026-09-27T10:00:00.000Z', finishedAt: '2026-09-27T10:02:00.000Z', status: 'passed', attempts: { 'a > one': 1, 'a > two': 1 } }) as RunSummary;

describe('a green run that contains a test which cannot fail', () => {
  it('does not read as a clean bill of health', () => {
    const refusals = [{ what: 'rejects an expired code (tests/cart.test.js:5) is in this change and cannot fail', why: 'an expectation was written but no matcher was called on it', runId: 'run-9' }];
    const bundle = attestRun('shop', run(), [], {
      checked: ['every test in this run passed', '2 test(s) in this change were read for whether they can fail at all, and 1 can'],
      notChecked: ['the application itself'],
      tool: 'tewip',
      engine: 'rules-9',
      refusals,
    });
    assert.equal(bundle.refusals.length, 1);
    const report = renderAttestation(bundle);
    assert.match(report, /Refused \(1\)/);
    assert.match(report, /cannot fail/);
    assert.doesNotMatch(report, /Nothing was left undecided in this run/, 'a refusal is present, so the bundle must not say otherwise');
  });

  it('still says nothing was undecided when nothing was', () => {
    const bundle = attestRun('shop', run(), [], { checked: ['every test passed'], notChecked: [], tool: 'tewip', engine: 'rules-9' });
    assert.deepEqual(bundle.refusals, []);
    assert.match(renderAttestation(bundle), /Nothing was left undecided in this run/);
  });
});

describe('the pull request comment', () => {
  const ctx = { runUrl: 'https://ci/1', sha: 'abcdef1234', runId: '1', repo: 'shop/web', suite: '' } as unknown as CiContext;

  it('qualifies "all tests passed" when a test in the change cannot fail', () => {
    // The early return for a green run was the subtle part: this is precisely the run where the
    // finding matters, and the first version of this wiring dropped it.
    const body = prCommentBody(ctx, [], null, [], [], undefined, ['## Tests in this change that cannot fail (1 of 2)', '', '- **rejects an expired code**']);
    assert.match(body, /all tests passed/);
    assert.match(body, /cannot fail \(1 of 2\)/);
  });

  it('says only that the tests passed when there is nothing to add', () => {
    const body = prCommentBody(ctx, [], null, [], [], undefined, []);
    assert.match(body, /all tests passed/);
    assert.doesNotMatch(body, /cannot fail/);
  });
});
