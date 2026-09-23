// A change that rewrites checks people already agreed on. The examples here are shaped after the
// real pull request that exposed the gap: budget-mvp#16 changed how an indicator's freshness was
// judged, changed the test to match, and was reverted the next day because the new rule was wrong.
// Every layer of Tewip had agreed with it, because every layer was reading the change's own account
// of itself.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedExpectations, renderExpectations } from '../review/expectations.ts';

const NL = String.fromCharCode(10);
const diff = (...lines: string[]) => lines.join(NL);

describe('checks a change renegotiates', () => {
  it('reports an expectation that was rewritten, with both texts', () => {
    const found = changedExpectations(
      '.',
      'range',
      diff(
        'diff --git a/src/indicator.test.ts b/src/indicator.test.ts',
        '@@ -12,1 +12,1 @@',
        "-    expect(computeFreshness({ value: 1, updatedAt: now }, now)).toBe('fresh');",
        "+    expect(computeFreshness({ value: 1, referenceDate: '2026-07-16' }, now)).toBe('stale');",
      ),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'rewritten');
    assert.match(found[0].before, /toBe\('fresh'\)/);
    assert.match(found[0].after, /toBe\('stale'\)/);
  });

  it('reports a check that was withdrawn and not replaced', () => {
    const found = changedExpectations('.', 'range', diff('diff --git a/tests/cart.spec.ts b/tests/cart.spec.ts', '@@ -8,2 +8,1 @@', '-  expect(total).toBe(42);', '-  expect(receipt).toContain("VAT");', '+  await page.screenshot();'));
    assert.equal(found.length, 2);
    assert.ok(found.every((f) => f.kind === 'withdrawn'));
    assert.match(renderExpectations(found).join(NL), /no longer checks/);
  });

  it('says nothing about a brand-new test file, which renegotiates nothing', () => {
    const found = changedExpectations(
      '.',
      'range',
      diff('diff --git a/tests/new.spec.ts b/tests/new.spec.ts', 'new file mode 100644', '@@ -0,0 +1,3 @@', "+it('adds an item', () => {", '+  expect(cart.items).toBe(1);', '+});'),
    );
    assert.deepEqual(found, [], 'adding checks is not renegotiating anything');
  });

  it('ignores changes outside test files', () => {
    const found = changedExpectations('.', 'range', diff('diff --git a/src/cart.ts b/src/cart.ts', '@@ -3,1 +3,1 @@', '-  assert(total > 0);', '+  assert(total >= 0);'));
    assert.deepEqual(found, []);
  });

  it('notices a test renamed into something else, even with no assertion change', () => {
    const found = changedExpectations(
      '.',
      'range',
      diff(
        'diff --git a/src/indicator.test.ts b/src/indicator.test.ts',
        '@@ -4,1 +4,1 @@',
        "-  it('is fresh within the crypto 15-minute window and stale just past it', () => {",
        "-  it('is unavailable when referenceDate is malformed', () => {".replace('-', '+'),
      ),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'renamed');
    assert.match(found[0].before, /crypto 15-minute window/);
    assert.match(found[0].after, /referenceDate is malformed/);
  });

  it('asks rather than decides, because tests change for good reasons', () => {
    const report = renderExpectations([{ file: 'a.test.ts', kind: 'rewritten', test: 'freshness', before: "toBe('fresh')", after: "toBe('stale')" }]).join(NL);
    assert.match(report, /this is not a fault/);
    assert.match(report, /Ask the author which of these the change intended/);
    assert.doesNotMatch(report, /wrong|broken|must/i, 'it never passes judgement on the change');
  });

  it('says nothing at all when no agreed check moved', () => {
    assert.deepEqual(renderExpectations([]), []);
  });
});
