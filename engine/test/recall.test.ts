// Phase 17: retrieval before generation. What these tests protect is that a memory is a record,
// not a guess - every answer names the run it came from - and that a person's correction outranks
// Tewip's own conclusion, because what the team decided beats what the tool decided.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, readJsonl } from '../../reporters/store.ts';
import { describe, it } from 'node:test';
import { memories, recall, renderRecall } from '../recall/recall.ts';
import { recallReport } from '../recall/recall-command.ts';
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

// Phase 54: the weekly shadow run had been red for three weeks and nobody was looking.
//
// It is the only thing measuring how good `explain` actually is - the command this whole project
// was built for - and it died in two different places, neither of which anyone would notice from
// the outside.
describe('reading a JSONL file that only ever grows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tewip-jsonl-'));

  it('reads a file larger than one chunk without mangling a character', () => {
    // `readFileSync(file, 'utf8')` builds one string, and a string in Node cannot exceed about
    // 512MB. The shadow datasets only ever grow - every CI failure harvested from a public project
    // is appended and kept - and gutenberg's crossed the limit, so every run since died on that
    // line. Reading in chunks introduces its own hazard: a UTF-8 character straddling a chunk
    // boundary decodes to U+FFFD and takes its whole line with it.
    const file = join(dir, 'big.jsonl');
    const rows: string[] = [];
    for (let i = 0; i < 120_000; i += 1) rows.push(JSON.stringify({ i, s: `ünïcödé-Ⅷ-日本語-${'x'.repeat(60)}` }));
    writeFileSync(file, `${rows.join('\n')}\n`);

    const back = readJsonl<{ i: number; s: string }>(file);
    assert.equal(back.length, 120_000);
    assert.equal(back.filter((r) => !r.s.startsWith('ünïcödé-Ⅷ-日本語-')).length, 0, 'a character was split across a chunk');
    assert.equal(back[0].i, 0);
    assert.equal(back[back.length - 1].i, 119_999);
  });

  it('still skips a malformed line rather than losing the file', () => {
    const file = join(dir, 'ragged.jsonl');
    writeFileSync(file, '{"a":1}\n{"a":2}\n\n{"bad"\n{"a":3}\n');
    assert.deepEqual(readJsonl(file), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('reads the last line when the file does not end in a newline', () => {
    const file = join(dir, 'nonl.jsonl');
    writeFileSync(file, '{"a":1}\n{"a":2}');
    assert.equal(readJsonl(file).length, 2);
  });

  it('yields nothing for a file that is not there', () => {
    assert.deepEqual(readJsonl(join(dir, 'absent.jsonl')), []);
  });
});

// Phase 58: `tewip prove reporters/store.ts` found that nothing checked the write at all. The
// guard `rows.length === 0` survived becoming `!==`, which turns every append into a no-op - the
// reporter would collect failures all day and write an empty file, and the suite above, which only
// ever reads files written by writeFileSync, would stay green through all of it.
describe('appending to a JSONL file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tewip-append-'));

  it('writes the rows it was given, one per line, and can read them back', () => {
    const file = join(dir, 'nested', 'deeper', 'rows.jsonl');
    appendJsonl(file, [{ a: 1 }, { a: 2 }]);
    appendJsonl(file, [{ a: 3 }]);
    assert.deepEqual(readJsonl(file), [{ a: 1 }, { a: 2 }, { a: 3 }], 'appending has to actually append');
    assert.equal(readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).length, 3, 'one row per line');
  });

  it('writes nothing at all - not even an empty file - for no rows', () => {
    const file = join(dir, 'untouched.jsonl');
    appendJsonl(file, []);
    assert.equal(existsSync(file), false, 'a run with no failures should leave no trace');
  });
});

// Phase 59: the audit that went looking for a command whose clean answer was unreachable.
//
// Recall was it. `memories()` keeps only records that carry a `diagnosis`, and nothing on the
// collection path writes one - the reporter and the harvest both store the raw failure, and the
// category is worked out when a report is rendered. So on a real 1,305-failure history recall had
// nothing to search, and said so as if that were a finding: "Nothing in this project's history
// resembles it... this is new here", footed by "Searched 1305 kept failure(s)". 660 of those 1,305
// failures were the timeout being asked about.
describe('recalling from a history nothing has diagnosed yet', () => {
  const NOW = '2026-10-16T08:00:00.000Z';
  const raw = (testId: string, errorMessage: string, runId: string) =>
    JSON.stringify({
      schemaVersion: 1, testId, file: 'editor/various/blocks.spec.js', status: 'failed',
      errorMessage, errorStack: '', duration: 31_000, retry: 0, attachments: [],
      runId, gitSha: 'abc1234', timestamp: NOW,
    });
  const summary = (runId: string, attempts: Record<string, number>) =>
    JSON.stringify({ schemaVersion: 1, runId, gitSha: 'abc1234', branch: 'trunk', startedAt: NOW, finishedAt: NOW, status: 'failed', attempts });

  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-recall-'));
    const where = join(root, '.tewip', 'history', 'app');
    mkdirSync(where, { recursive: true });
    const timeout = 'TimeoutError: locator.waitFor: Timeout 17500ms exceeded. Call log: - waiting for getByRole(\'button\', { name: /Collaborators list/ }) to be visible';
    writeFileSync(join(where, 'triage.jsonl'), [
      raw('editor > collaborators are listed', timeout, 'r1'),
      raw('editor > collaborators are listed', timeout, 'r2'),
      raw('editor > a paragraph keeps its colour', 'Error: expect(received).toBe(expected) Expected: "red" Received: "blue"', 'r3'),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10));
    writeFileSync(join(where, 'runs.jsonl'), [
      summary('r1', { 'editor > collaborators are listed': 1 }),
      summary('r2', { 'editor > collaborators are listed': 1 }),
      summary('r3', { 'editor > a paragraph keeps its colour': 1 }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10));
    return root;
  };

  it('finds the earlier failures even though none of them carries a stored diagnosis', async () => {
    const root = project();
    const { report, searched } = await recallReport({ root, question: 'locator.waitFor: Timeout 30000ms exceeded waiting for getByRole' });
    assert.equal(searched, 3, 'every kept failure is searchable, diagnosed on read the way the note already does');
    assert.match(report, /earlier failure\(s\) look like this one/);
    assert.match(report, /collaborators are listed/, 'the two timeouts are what the question was about');
    assert.doesNotMatch(report, /this is new here/, 'it is not new here: it has happened twice');
  });

  it('counts what it searched, not what is on disk', async () => {
    const root = project();
    const { searched } = await recallReport({ root, question: 'something nothing here resembles at all: quantum flux capacitor' });
    assert.equal(searched, 3);
    const { report } = await recallReport({ root, question: 'something nothing here resembles at all: quantum flux capacitor' });
    assert.match(report, /the 3 diagnosed failure\(s\) kept here/, 'an empty answer has to carry the denominator it was empty against');
  });

  it('says nothing has been kept rather than that nothing resembles it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-recall-empty-'));
    const { report, searched } = await recallReport({ root, question: 'anything' });
    assert.equal(searched, 0);
    assert.match(report, /Nothing has been kept here yet/);
  });
});
