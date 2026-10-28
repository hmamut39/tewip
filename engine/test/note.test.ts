// Phase 114: the weekly note's heading disagreed with its own body.
//
// `tewip note` is the report a lead reads on a Monday, and its heading counted records from
// triage.jsonl - where the reporter writes one line per attempt, so a retried test is counted
// three times. The digest and the quality breakdown printed directly underneath count one entry
// per failing test per run. On the real gutenberg history the heading said "1053 failure(s)" over
// a body that added up to 553, and nothing in the page explained the gap.
//
// A number nobody can reconcile with the table beneath it is worse than no number: the reader
// cannot tell which half to believe, and the honest-looking one is the wrong one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNote } from '../notify/note-command.ts';

const NL = String.fromCharCode(10);
const NOW = new Date().toISOString();

const attempt = (testId: string, retry: number, runId: string) =>
  JSON.stringify({
    schemaVersion: 1, testId, file: 'tests/a.spec.ts', status: 'failed',
    errorMessage: 'Error: expect(received).toBe(expected) Expected: "red" Received: "blue"',
    errorStack: '', duration: 1, retry, attachments: [], runId, gitSha: 'abc1234', timestamp: NOW,
    diagnosis: { category: 'REAL_BUG', confidence: 0.9, source: 'rules', evidence: [{ source: 'real-bug-assertion', message: 'failed every recorded run with the same mismatch' }] },
  });

const summary = (runId: string, attempts: Record<string, number>) =>
  JSON.stringify({ schemaVersion: 1, runId, gitSha: 'abc1234', branch: 'trunk', startedAt: NOW, finishedAt: NOW, status: 'failed', attempts });

/** A project whose kept history has `tests` failing tests, each retried `retries` times, in one run. */
function project(tests: string[], retries: number): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-note-'));
  const where = join(root, '.tewip', 'history', 'app');
  mkdirSync(where, { recursive: true });
  const lines = tests.flatMap((testId) => Array.from({ length: retries }, (_, retry) => attempt(testId, retry, 'r1')));
  writeFileSync(join(where, 'triage.jsonl'), `${lines.join(NL)}${NL}`, 'utf8');
  writeFileSync(join(where, 'runs.jsonl'), `${summary('r1', Object.fromEntries(tests.map((t) => [t, retries])))}${NL}`, 'utf8');
  return root;
}

const headline = (note: string): string => note.match(/^\d+ run\(s\), (\d+) failure\(s\)\.$/m)?.[1] ?? 'no headline found';

describe('the weekly note counts failures, not attempts', () => {
  it('counts a test retried three times once', async () => {
    const note = await runNote({ root: project(['cart > totals'], 3), days: 7, post: false });
    assert.equal(headline(note), '1', 'one test failed, three times over');
    assert.doesNotMatch(note, /1 run\(s\), 3 failure\(s\)/, 'the three records are three attempts, not three failures');
  });

  it('still counts two failing tests as two', async () => {
    // The guard above must not be bought by collapsing everything to one.
    const note = await runNote({ root: project(['cart > totals', 'checkout > pays'], 3), days: 7, post: false });
    assert.equal(headline(note), '2');
  });

  it('agrees with the breakdown printed underneath it', async () => {
    // The property that was actually broken, asserted against the number the body itself prints
    // rather than against a constant: the quality view says "N failing test case(s)", and the
    // heading has to be that same N whatever either of them works out to be.
    const note = await runNote({ root: project(['cart > totals', 'checkout > pays', 'cart > tax'], 2), days: 7, post: false });
    const body = note.match(/(\d+) failing test case\(s\)/)?.[1];
    assert.equal(body, '3', 'the quality view counts failing tests');
    assert.equal(headline(note), body, 'and the heading above it says the same thing');
    assert.doesNotMatch(note, /6 failure\(s\)/, 'six records describe three failing tests');
  });
});

// Phase 114, found while reading the note above: every item line said `source: rules undefined`.
//
// `engineVersion` is typed `string` on the record, so no check ever complained - but a stored
// history is untyped JSON read off disk, and one written before the field existed has no value
// for it. The word `undefined` in a report is a small dishonesty that costs the numbers beside it
// their credibility.
describe('a report never prints the word undefined at a reader', () => {
  it('says the engine version was not recorded, rather than that it is undefined', async () => {
    // The fixture's stored diagnoses carry no engineVersion, which is exactly the real case.
    // Three tests failing the same way, because the per-failure block that carries the source line
    // is only printed once there is a recurring pattern to show it under.
    const note = await runNote({ root: project(['cart > totals', 'checkout > pays', 'cart > tax'], 2), days: 7, post: false });
    assert.doesNotMatch(note, /undefined/, 'nothing in a quality note may read "undefined"');
    assert.match(note, /source: rules \(version not recorded\)/, 'and the absence is named');
  });
});
