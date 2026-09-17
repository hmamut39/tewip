// Unit tests for the LEARN step: a person's correction is read from a comment, matched to the
// failure it was written about, and used instead of the agent's own answer next time.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseBoardMap, readCorrections, renderBoardMap } from '../../ci/corrections.ts';
import type { GitHub } from '../../ci/github.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { applyCorrection, correctionFor, loadCorrections, parseCorrectionCommands, saveCorrections, type Correction } from '../corrections.ts';
import { HistoryIndex } from '../history.ts';
import { diagnosePipeline } from '../pipeline.ts';
import { errorShape } from '../signature.ts';

const record = (testId: string, errorMessage: string, runId = 'r1'): TriageRecord => ({
  schemaVersion: 1,
  testId,
  file: 'shop.spec.ts',
  status: 'failed',
  errorMessage,
  errorStack: '',
  duration: 1,
  retry: 0,
  attachments: [],
  runId,
  gitSha: '',
  timestamp: '2026-01-01T00:00:00Z',
});
const summary = (runId: string, testIds: string[]): RunSummary => ({ schemaVersion: 1, runId, gitSha: '', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z', status: 'failed', attempts: Object.fromEntries(testIds.map((t) => [t, 1])) });

const ERROR = 'Error: something no rule understands';
const TEST = 'shop.spec.ts > pays with card';
const correction = (over: Partial<Correction> = {}): Correction => ({
  schemaVersion: 1,
  testId: TEST,
  errorShape: errorShape(ERROR),
  category: 'TEST_DATA',
  by: 'amina',
  at: '2026-01-02T00:00:00Z',
  reason: 'the fixture user has no saved card',
  source: 'PR #7 comment',
  ...over,
});

describe('reading corrections from a comment', () => {
  it('reads the category, the failure number and the reason', () => {
    const parsed = parseCorrectionCommands('Thanks, but this one is wrong.\n/triage TIMING #2 flaky on CI runners\n');
    assert.deepEqual(parsed, [{ category: 'TIMING', item: 2, reason: 'flaky on CI runners' }]);
  });

  it('ignores words that are not categories', () => {
    assert.deepEqual(parseCorrectionCommands('/triage MAYBE_LATER #1'), []);
  });
});

describe('matching a correction to a failure', () => {
  it('applies to the same test failing the same way, not to a different failure of it', () => {
    const corrections = [correction()];
    assert.equal(correctionFor(record(TEST, ERROR), corrections)?.category, 'TEST_DATA');
    assert.equal(correctionFor(record(TEST, 'Error: a completely different failure'), corrections), null);
    assert.equal(correctionFor(record('shop.spec.ts > other test', ERROR), corrections), null);
  });

  it('keeps what the agent had said, so the disagreement stays visible', () => {
    const before = { category: 'ENV' as const, confidence: 0.7, source: 'llm' as const, engineVersion: 'rules-5', diagnosedAt: '', evidence: [{ source: 'llm', message: 'looked like an outage' }] };
    const after = applyCorrection(before, correction());
    assert.equal(after.category, 'TEST_DATA');
    assert.equal(after.confidence, 1);
    assert.equal(after.source, 'human');
    assert.match(after.evidence[0].message, /@amina corrected this to TEST_DATA: the fixture user has no saved card/);
    assert.equal((after.evidence[0].data as { was: string }).was, 'ENV at 0.70');
    assert.ok(after.evidence.some((e) => e.message === 'looked like an outage'));
  });
});

describe('the pipeline with corrections', () => {
  it("uses the person's category and never asks the model about it again", async () => {
    const r = record(TEST, ERROR);
    const index = new HistoryIndex([r], [summary('r1', [TEST])]);
    let asked = 0;
    const llm = {
      model: 'test',
      complete: async () => {
        asked++;
        return JSON.stringify({ category: 'ENV', confidence: 0.9, reasoning: 'x', evidence: [] });
      },
    };
    const [corrected] = await diagnosePipeline([r], index, llm, { corrections: [correction()] });
    assert.equal(corrected.category, 'TEST_DATA');
    assert.equal(asked, 0);

    const [uncorrected] = await diagnosePipeline([r], index, llm, { corrections: [] });
    assert.equal(uncorrected.category, 'ENV');
    assert.equal(asked, 1);
  });
});

describe('storing corrections', () => {
  it('appends new ones and ignores repeats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-corrections-'));
    assert.equal(saveCorrections(dir, [correction()]).length, 1);
    assert.equal(saveCorrections(dir, [correction()]).length, 0);
    assert.equal(saveCorrections(dir, [correction({ category: 'TIMING' })]).length, 1);
    assert.equal(loadCorrections(dir).length, 2);
  });
});

describe('the hidden board map in the agent comment', () => {
  const items = [
    { runId: 'r1', testId: TEST, diagnosis: { category: 'ENV' } },
    { runId: 'r1', testId: 'shop.spec.ts > other test', diagnosis: { category: 'TIMING' } },
  ] as never as Parameters<typeof renderBoardMap>[0];
  const records = [record(TEST, ERROR), record('shop.spec.ts > other test', 'Error: another thing')];

  it('survives a round trip, so "#2" keeps meaning the same failure', () => {
    const map = parseBoardMap(`## board\n${renderBoardMap(items, records)}`);
    assert.equal(map.get(2)?.testId, 'shop.spec.ts > other test');
    assert.equal(map.get(1)?.errorShape, errorShape(ERROR));
  });

  it('turns a human reply into a correction for the right failure', async () => {
    const comments = [
      { id: 1, body: `## triage-agent\n${renderBoardMap(items, records)}`, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2026-01-01T10:00:00Z', html_url: '' },
      { id: 2, body: 'no, this is our test data\n/triage TEST_DATA #1 the fixture user has no card', user: { login: 'amina', type: 'User' }, created_at: '2026-01-01T11:00:00Z', html_url: '' },
    ];
    const github = { request: async () => comments } as unknown as GitHub;
    const [c] = await readCorrections(github, 7, 'PR #7');
    assert.equal(c.testId, TEST);
    assert.equal(c.category, 'TEST_DATA');
    assert.equal(c.by, 'amina');
    assert.equal(c.wasCategory, 'ENV');
  });
});
