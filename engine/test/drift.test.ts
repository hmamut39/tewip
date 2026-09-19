// Unit tests for the strict-mode drift rule on error messages shaped like real Gutenberg CI
// failures. They check the rule's logic, not its accuracy on real data.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TriageRecord } from '../../reporters/types.ts';
import { strictCandidates } from '../autofix/candidates.ts';
import { decide } from '../decide.ts';
import { diagnose } from '../engine.ts';
import { locatorName, strictModeViolation } from '../error-parse.ts';
import { HistoryIndex } from '../history.ts';

const CANVAS = (n: number) =>
  `    ${n}) <div tabindex="0" role="button" aria-label="Editor canvas" class="canvas-stop">…</div> aka getByRole('button', { name: 'Editor canvas' }).nth(${n - 1})`;

const clickStrict = (locator: string, lines: string[]) =>
  `Error: locator.click: Error: strict mode violation: ${locator} resolved to ${lines.length} elements:\n${lines.join('\n')}\n\nCall log:\n  - waiting for ${locator}\n`;

const EDIT_LINK = `    3) <button type="button" aria-label="Edit link">…</button> aka getByRole('button', { name: 'Edit link' })`;
const EDIT = "getByRole('button', { name: 'Edit' })";

function run(errorMessage: string) {
  const record: TriageRecord = {
    schemaVersion: 1,
    testId: 'buttons.spec.js > can toggle link settings',
    file: 'buttons.spec.js',
    status: 'failed',
    errorMessage,
    errorStack: errorMessage,
    duration: 100,
    retry: 0,
    attachments: [],
    runId: 'r1',
    gitSha: '',
    timestamp: '2026-01-01T00:00:00Z',
  };
  const index = new HistoryIndex([record], [{ schemaVersion: 1, runId: 'r1', gitSha: '', startedAt: record.timestamp, finishedAt: record.timestamp, status: 'failed', attempts: { [record.testId]: 1 } }]);
  return diagnose({ record, history: index.historyAsOf(record.testId, 'r1'), run: index.runContext('r1'), loadSnapshot: () => null });
}

describe('strict-mode violation parsing', () => {
  it('reads the locator, the count, and the locator Playwright suggests for each element', () => {
    const v = strictModeViolation(clickStrict(EDIT, [CANVAS(1), CANVAS(2), EDIT_LINK]))!;
    assert.equal(v.locator, EDIT);
    assert.equal(v.count, 3);
    assert.equal(v.isAction, true);
    assert.deepEqual(v.elements[2], { locator: "getByRole('button', { name: 'Edit link' })", role: 'button', name: 'Edit link' });
  });

  it('reads the name a locator looks for', () => {
    assert.equal(locatorName("getByRole('region', { name: 'Editor content' }).getByRole('button', { name: 'Edit' })"), 'Edit');
    assert.equal(locatorName("getByText('Don\\'t save')"), "Don't save");
    assert.equal(locatorName("locator('#save')"), null);
  });
});

describe('locator-drift-strict rule', () => {
  it('calls drift when exactly one matched element carries the name as a whole word, and suggests its locator', () => {
    const d = run(clickStrict(EDIT, [CANVAS(1), CANVAS(2), EDIT_LINK]));
    assert.equal(d.category, 'LOCATOR_DRIFT');
    assert.equal(d.ruleId, 'locator-drift-strict');
    const action = decide(d, { locator: EDIT, suggestedLocator: "getByRole('button', { name: 'Edit link' })", strictMatches: 3 });
    assert.equal(action.autonomous, true);
    assert.match(action.summary, /Change the locator .* to getByRole\('button', \{ name: 'Edit link' \}\)/);
    assert.deepEqual(strictCandidates(d).map((c) => c.expression), ["getByRole('button', { name: 'Edit link' })"]);
  });

  it('declines when the name only appears inside longer words ("Edit" in "Editor canvas")', () => {
    const d = run(clickStrict(EDIT, [CANVAS(1), CANVAS(2)]));
    assert.notEqual(d.category, 'LOCATOR_DRIFT');
    assert.ok(d.evidence.some((e) => e.source === 'locator-drift-strict' && /none is named "Edit"/.test(e.message)));
  });

  it('declines for assertions, which may be a behaviour change', () => {
    const message = `Error: expect(locator).toBeHidden() failed\n\nLocator: ${EDIT}\nExpected: hidden\nError: strict mode violation: ${EDIT} resolved to 2 elements:\n${CANVAS(1)}\n${EDIT_LINK}\n\nCall log:\n  - waiting for ${EDIT}\n`;
    assert.notEqual(run(message).category, 'LOCATOR_DRIFT');
  });

  it('treats names Playwright shortened as the same name: two identical items are not drift', () => {
    const id = "getByRole('checkbox', { name: '64966a11-b3fa-4c41-b5bd-851a097bec81' })";
    const item = (n: number) => `    ${n}) <input type="checkbox"> aka getByRole('checkbox', { name: '64966a11-b3fa-4c41-b5bd-' }).nth(${n - 1})`;
    const d = run(clickStrict(id, [item(1), item(2)]));
    assert.notEqual(d.category, 'LOCATOR_DRIFT');
    assert.ok(d.evidence.some((e) => e.source === 'locator-drift-strict' && /2 of them are named/.test(e.message)));
  });

  it('declines when several elements carry the name', () => {
    const code = `    2) <button>Edit code</button> aka getByRole('button', { name: 'Edit code' })`;
    assert.notEqual(run(clickStrict(EDIT, [EDIT_LINK, code])).category, 'LOCATOR_DRIFT');
  });
});

describe('timing-intercepted rule', () => {
  it('a ready element whose click is blocked by something on top is TIMING, not a broken feature', () => {
    const message = [
      'TimeoutError: locator.click: Timeout 10000ms exceeded.',
      'Call log:',
      "  - waiting for getByRole('button', { name: 'Publish' })",
      '    - locator resolved to <button id="publish">Publish</button>',
      '    - attempting click action',
      '    - waiting for element to be visible, enabled and stable',
      '    - element is visible, enabled and stable',
      '    - <div class="components-snackbar">…</div> from <div class="snackbar-list">…</div> subtree intercepts pointer events',
      '',
    ].join('\n');
    const d = run(message);
    assert.equal(d.category, 'TIMING');
    assert.equal(d.ruleId, 'timing-intercepted');
    assert.ok(d.confidence < 0.85, 'stays below the auto-fix threshold');
    assert.match(d.evidence[0].message, /still on top of it/);
  });
});

describe('timing-known-flaky rule', () => {
  const ERR = 'Error: expect(locator).toBeFocused() failed';
  const TEST = 'nav.spec.ts > focuses the menu';
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const fail = (runId: string, sha: string, retry: number, minute: number): TriageRecord => ({
    schemaVersion: 1, testId: TEST, file: 'nav.spec.ts', status: 'failed', errorMessage: ERR, errorStack: ERR, duration: 1, retry, attachments: [], runId, gitSha: sha, timestamp: at(minute),
  });
  const run = (runId: string, sha: string, attempts: number, minute: number) => ({ schemaVersion: 1, runId, gitSha: sha, startedAt: at(minute), finishedAt: at(minute), status: 'failed', attempts: { [TEST]: attempts } });

  it('calls a known flaky test failing its old way TIMING', () => {
    // Run 1 flaked (failed, then passed on the retry); run 2, on another commit, fails the same way.
    const records = [fail('r1', 'aaa', 0, 1), fail('r2', 'bbb', 0, 2)];
    const index = new HistoryIndex(records, [run('r1', 'aaa', 2, 1), run('r2', 'bbb', 1, 2)]);
    const d = diagnose({ record: records[1], history: index.historyAsOf(TEST, 'r2'), run: index.runContext('r2'), loadSnapshot: () => null });
    assert.equal(d.category, 'TIMING');
    assert.equal(d.ruleId, 'timing-known-flaky');
  });

  it('does not excuse a regression that fails every retry on this commit while passing elsewhere', () => {
    const records = [fail('r1', 'aaa', 0, 1), fail('r3', 'ccc', 0, 3), fail('r3', 'ccc', 1, 3)];
    const index = new HistoryIndex(records, [run('r1', 'aaa', 2, 1), run('r2', 'bbb', 1, 2), run('r3', 'ccc', 2, 3)]);
    const d = diagnose({ record: records[2], history: index.historyAsOf(TEST, 'r3'), run: index.runContext('r3'), loadSnapshot: () => null });
    // Still most likely the old flake, but not trusted enough to let the merge gate wave it through.
    assert.equal(d.ruleId, 'timing-known-flaky');
    assert.ok(d.confidence < 0.7, `confidence ${d.confidence} must stay below the gate's threshold`);
    assert.match(d.evidence[0].message, /how a regression looks: a person should confirm/);
  });
});

