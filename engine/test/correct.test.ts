// The LEARN step, everywhere. What is tested is that a person's decision is stored where the thing
// that decided will look for it, that it is shown as theirs rather than as Tewip's, and that it
// changes what Tewip *says* without ever changing what it *does* on its own.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCorrect } from '../learn/correct-command.ts';
import { isVerdictWord, loadVerdicts, saidByAPerson, saveVerdict, verdictFor, VERDICT_WORDS } from '../learn/verdicts.ts';
import { correctionFor, loadCorrections } from '../corrections.ts';
import { errorShape } from '../signature.ts';
import type { TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);

const record = (): TriageRecord =>
  ({
    schemaVersion: 1,
    testId: 'shop > computes the total',
    file: 'tests/shop.test.ts',
    status: 'failed',
    errorMessage: 'Expected: 4\nReceived: 3',
    errorStack: '',
    duration: 10,
    retry: 0,
    attachments: [],
    runId: 'r1',
    gitSha: '',
    timestamp: new Date().toISOString(),
    diagnosis: { category: 'REAL_BUG', confidence: 0.9 },
  }) as unknown as TriageRecord;

/** A project with one run of history, the way `tewip explain` leaves it. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-correct-'));
  const history = join(root, '.tewip', 'history', 'shop');
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, 'triage.jsonl'), `${JSON.stringify(record())}${NL}`, 'utf8');
  writeFileSync(join(history, 'runs.jsonl'), `${JSON.stringify({ schemaVersion: 1, runId: 'r1', gitSha: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'failed', attempts: { 'shop > computes the total': 1 } })}${NL}`, 'utf8');
  return root;
}

describe('correcting a diagnosis', () => {
  it('stores it where the engine looks, matched the way the engine matches', () => {
    // Both halves of this were wrong at first: it was written one folder up, where nothing read it,
    // and the error shape was stored truncated, so it could never equal a real one.
    const root = project();
    const said = runCorrect({ root, kind: 'diagnosis', key: 'computes the total', verdict: 'TEST_DATA', reason: 'the fixture has stale prices', by: 'sam' });
    assert.match(said, /is TEST_DATA, not REAL_BUG/);

    const corrections = loadCorrections(join(root, '.tewip', 'history', 'shop'));
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].errorShape, errorShape(record().errorMessage), 'stored exactly as the matcher compares it');
    assert.ok(correctionFor(record(), corrections), 'the engine finds it for the same failure');
    assert.equal(corrections[0].wasCategory, 'REAL_BUG', 'what Tewip had said is kept, so the pair is a labelled example');
  });

  it('refuses a category that does not exist, and a test it has never seen', () => {
    const root = project();
    assert.throws(() => runCorrect({ root, kind: 'diagnosis', key: 'computes the total', verdict: 'DEFINITELY_A_BUG' }), /is not a category/);
    assert.throws(() => runCorrect({ root, kind: 'diagnosis', key: 'a test nobody ran', verdict: 'TIMING' }), /Run `tewip explain` on the report first/);
  });
});

describe('correcting everything else Tewip decides', () => {
  it('keeps a person\'s verdict and shows it as theirs', () => {
    const root = project();
    runCorrect({ root, kind: 'flaky', key: 'adds an item', verdict: 'fix-now', reason: 'it is a real race', by: 'sam' });
    const found = verdictFor('flaky', 'cart > adds an item', loadVerdicts(root));
    assert.equal(found?.verdict, 'fix-now');
    assert.match(saidByAPerson(found!), /^sam decided this on \d{4}-\d{2}-\d{2}: it is a real race$/);
  });

  it('lets a team change its mind without editing a file', () => {
    const root = project();
    saveVerdict(root, { kind: 'security', key: 'src/config.ts:12', verdict: 'noise', reason: 'a fixture', by: 'sam', at: '2026-09-01T00:00:00Z' });
    saveVerdict(root, { kind: 'security', key: 'src/config.ts:12', verdict: 'real-risk', reason: 'it is live after all', by: 'alex', at: '2026-09-20T00:00:00Z' });
    assert.equal(verdictFor('security', 'src/config.ts:12', loadVerdicts(root))?.verdict, 'real-risk', 'the newest answer wins');
  });

  it('refuses a word that kind of verdict does not use', () => {
    const root = project();
    assert.throws(() => runCorrect({ root, kind: 'flaky', key: 'adds an item', verdict: 'delete-it' }), /is not one of the answers a flaky verdict takes/);
    assert.throws(() => runCorrect({ root, kind: 'vibes', key: 'x', verdict: 'good' }), /is not something Tewip decides/);
    assert.equal(isVerdictWord('design', 'not-a-difference'), true);
    assert.equal(isVerdictWord('design', 'quarantine'), false);
  });

  it('says plainly that a correction never makes Tewip act', () => {
    const root = project();
    const said = runCorrect({ root, kind: 'security', key: 'src/config.ts:12', verdict: 'noise', reason: 'a fixture', by: 'sam' });
    assert.match(said, /changes what it says, never what it does/);
  });

  it('lists what the team has corrected, from both stores', () => {
    const root = project();
    runCorrect({ root, kind: 'diagnosis', key: 'computes the total', verdict: 'TEST_DATA', by: 'sam' });
    runCorrect({ root, kind: 'flaky', key: 'adds an item', verdict: 'watch', by: 'alex' });
    const listed = runCorrect({ root, kind: '', list: true });
    assert.match(listed, /2 correction\(s\)/);
    assert.match(listed, /flaky\s+adds an item -> watch/);
    assert.match(listed, /diagnosis shop > computes the total -> TEST_DATA/);
  });

  it('offers every kind an answer, and says which words each takes', () => {
    const empty = runCorrect({ root: mkdtempSync(join(tmpdir(), 'tewip-none-')), kind: '', list: true });
    assert.match(empty, /Nothing has been corrected yet/);
    for (const [kind, words] of Object.entries(VERDICT_WORDS)) {
      assert.match(empty, new RegExp(kind));
      assert.match(empty, new RegExp(words[0].replace(/[-]/g, '\\-')));
    }
  });
});
