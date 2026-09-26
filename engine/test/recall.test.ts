// Phase 17: retrieval before generation. What these tests protect is that a memory is a record,
// not a guess - every answer names the run it came from - and that a person's correction outranks
// Tewip's own conclusion, because what the team decided beats what the tool decided.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memories, recall, renderRecall } from '../recall/recall.ts';
import { errorShape } from '../signature.ts';
import type { Correction } from '../corrections.ts';
import type { TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);

const record = (testId: string, error: string, category: string, when = '2026-09-01T00:00:00.000Z', runId = 'r1'): TriageRecord =>
  ({
    schemaVersion: 1, testId, file: 'tests/a.spec.ts', status: 'failed', errorMessage: error, errorStack: '',
    duration: 1, retry: 0, attachments: [], runId, gitSha: '', timestamp: when,
    diagnosis: { category, confidence: 0.8, source: 'rules', evidence: [] },
  }) as unknown as TriageRecord;

describe('what the project already knows', () => {
  it('finds the same error again, whatever the changing parts say', () => {
    const history = memories([
      record('checkout > pays', 'TimeoutError: locator.click: Timeout 10000ms exceeded waiting for getByRole(\'button\')', 'TIMING'),
      record('cart > adds', 'Error: expect(received).toBe(expected) 3 !== 4', 'REAL_BUG'),
    ]);
    const [top] = recall("TimeoutError: locator.click: Timeout 30000ms exceeded waiting for getByRole('button')", history);
    assert.equal(top.testId, 'checkout > pays');
    assert.match(top.why, /the same error, word for word/);
    assert.ok(top.score >= 0.95);
  });

  it('answers with a record, never a guess: the run and the decider are always named', () => {
    const history = memories([record('checkout > pays', 'socket hang up', 'ENV', '2026-08-30T00:00:00.000Z', 'run-42')]);
    const report = renderRecall('socket hang up', recall('socket hang up', history));
    assert.match(report, /run `run-42`/);
    assert.match(report, /Decided by rules on 2026-08-30/);
    assert.match(report, /No model was called/);
  });

  it('puts a person\'s correction above Tewip\'s own conclusion', () => {
    const error = 'Error: expect(locator).toBeVisible() failed';
    const corrections: Correction[] = [
      { schemaVersion: 1, testId: 'cart > shows total', errorShape: errorShape(error), category: 'TEST_DATA', by: 'sam', at: '2026-09-02T00:00:00.000Z', reason: 'the fixture has stale prices', source: 'test' } as unknown as Correction,
    ];
    const history = memories([record('cart > shows total', error, 'REAL_BUG')], corrections);
    const [top] = recall(error, history);
    assert.equal(top.category, 'TEST_DATA', 'the person overruled the rule, so that is what the project decided');
    assert.equal(top.correctedBy, 'sam');
    assert.match(renderRecall(error, [top]), /They said: the fixture has stale prices/);
  });

  it('says plainly when nothing resembles it, instead of returning the nearest thing', () => {
    const history = memories([record('cart > adds', 'socket hang up', 'ENV')]);
    const found = recall('the invoice PDF has the wrong VAT column', history);
    assert.deepEqual(found, []);
    assert.match(renderRecall('the invoice PDF has the wrong VAT column', found), /That is an answer, not a failure/);
  });

  it('prefers the same test when asked about one', () => {
    const error = 'TimeoutError: waiting for the dialog';
    const history = memories([
      record('other > thing', error, 'TIMING', '2026-09-03T00:00:00.000Z'),
      record('checkout > pays', error, 'ENV', '2026-09-01T00:00:00.000Z'),
    ]);
    const [top] = recall(error, history, { testId: 'checkout > pays' });
    assert.equal(top.testId, 'checkout > pays');
    assert.match(top.why, /the same test/);
  });

  it('ignores the words every stack trace has', () => {
    // "error", "failed", "timeout" match everything, so they must not make two failures look alike.
    const history = memories([record('a > one', 'Error: test failed with timeout waiting for the queue', 'TIMING')]);
    assert.deepEqual(recall('Error: test failed', history), [], 'nothing specific was shared');
  });

  it('reads a run with no diagnosis as no memory at all', () => {
    const raw = { ...record('a > one', 'boom', 'ENV') } as Record<string, unknown>;
    delete raw.diagnosis;
    assert.deepEqual(memories([raw as unknown as TriageRecord]), []);
  });

  it('holds its evidence on one line each, so a report stays readable', () => {
    const history = memories([record('a > one', 'x'.repeat(500), 'ENV')]);
    assert.ok(history[0].error.length <= 220);
    assert.ok(!renderRecall('x'.repeat(500), recall('x'.repeat(500), history)).split(NL).some((l) => l.length > 400));
  });
});
