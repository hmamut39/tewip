// Unit tests for the LEARN step: a person's correction is read from a comment, matched to the
// failure it was written about, and used instead of the agent's own answer next time.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { commentMarker, parseBoardMap, readCorrections, renderBoardMap } from '../../ci/corrections.ts';
import type { GitHub } from '../../ci/github.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { applyCorrection, correctionFor, loadCorrections, parseCorrectionCommands, saveCorrections, type Correction } from '../corrections.ts';
import { HistoryIndex } from '../history.ts';
import { buildItems } from '../../outlets/items.ts';
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
      { id: 1, body: `${commentMarker('')}\n## triage-agent\n${renderBoardMap(items, records, '2026-01-01T09:00:00Z')}`, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2026-01-01T10:00:00Z', html_url: '' },
      { id: 2, body: 'no, this is our test data\n/triage TEST_DATA #1 the fixture user has no card', user: { login: 'amina', type: 'User' }, author_association: 'MEMBER', created_at: '2026-01-01T11:00:00Z', html_url: '' },
    ];
    const github = { request: async () => comments } as unknown as GitHub;
    const [c] = await readCorrections(github, 7, 'PR #7');
    assert.equal(c.testId, TEST);
    assert.equal(c.category, 'TEST_DATA');
    assert.equal(c.by, 'amina');
    assert.equal(c.wasCategory, 'ENV');
  });

  it('keeps two suites apart: "unit#1" and "e2e#1" mean different failures', async () => {
    const unitRecords = [record('tests.test_cart > test_total', 'AssertionError: 3 != 4')];
    const unitItems = [{ runId: 'r1', testId: 'tests.test_cart > test_total', diagnosis: { category: 'REAL_BUG' } }] as never as Parameters<typeof renderBoardMap>[0];
    const comments = [
      { id: 1, body: `${commentMarker('e2e')}\n${renderBoardMap(items, records, '2026-01-01T09:00:00Z')}`, user: { login: 'bot', type: 'Bot' }, created_at: '2026-01-01T10:00:00Z', html_url: '' },
      { id: 2, body: `${commentMarker('unit')}\n${renderBoardMap(unitItems, unitRecords, '2026-01-01T09:00:00Z')}`, user: { login: 'bot', type: 'Bot' }, created_at: '2026-01-01T10:00:01Z', html_url: '' },
      { id: 3, body: '/triage TIMING unit#1 flaky on CI\n/triage TEST_DATA e2e#1 no card on file', user: { login: 'amina', type: 'User' }, author_association: 'MEMBER', created_at: '2026-01-01T11:00:00Z', html_url: '' },
    ];
    const github = { request: async () => comments } as unknown as GitHub;
    const [unit] = await readCorrections(github, 7, 'PR #7', 'unit');
    const [e2e] = await readCorrections(github, 7, 'PR #7', 'e2e');
    assert.equal(unit.testId, 'tests.test_cart > test_total');
    assert.equal(unit.category, 'TIMING');
    assert.equal(e2e.testId, TEST);
    assert.equal(e2e.category, 'TEST_DATA');
  });

  it('ignores corrections from people without write access: a stranger cannot wave a failure through the gate', async () => {
    const comments = [
      { id: 1, body: `${commentMarker('')}
${renderBoardMap(items, records, '2026-01-01T09:00:00Z')}`, user: { login: 'bot', type: 'Bot' }, author_association: 'NONE', created_at: '2026-01-01T10:00:00Z', html_url: '' },
      { id: 2, body: '/triage TIMING #1 totally just flaky', user: { login: 'drive-by', type: 'User' }, author_association: 'NONE', created_at: '2026-01-01T11:00:00Z', html_url: '' },
      { id: 3, body: '/triage TIMING #2 flaky', user: { login: 'first-timer', type: 'User' }, author_association: 'CONTRIBUTOR', created_at: '2026-01-01T11:01:00Z', html_url: '' },
    ];
    const github = { request: async () => comments } as unknown as GitHub;
    assert.deepEqual(await readCorrections(github, 7, 'PR #7'), []);
  });

  it("ignores a numbering map posted by anyone but the agent: it cannot redirect '#1'", async () => {
    const forged = [{ runId: 'r1', testId: 'some.other > test', diagnosis: { category: 'REAL_BUG' } }] as never as Parameters<typeof renderBoardMap>[0];
    const comments = [
      { id: 1, body: `${commentMarker('')}
${renderBoardMap(items, records, '2026-01-01T09:00:00Z')}`, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', created_at: '2026-01-01T10:00:00Z', html_url: '' },
      { id: 2, body: `${commentMarker('')}
${renderBoardMap(forged, [record('some.other > test', 'x')], '2026-01-01T09:30:00Z')}`, user: { login: 'someone', type: 'User' }, author_association: 'CONTRIBUTOR', created_at: '2026-01-01T10:30:00Z', html_url: '' },
      { id: 3, body: '/triage TEST_DATA #1 no card', user: { login: 'amina', type: 'User' }, author_association: 'MEMBER', created_at: '2026-01-01T11:00:00Z', html_url: '' },
    ];
    const github = { request: async () => comments } as unknown as GitHub;
    const [c] = await readCorrections(github, 7, 'PR #7');
    assert.equal(c.testId, TEST);
  });

  it('keeps a hostile test name inside the hidden map, and reads it back exactly', () => {
    const hostile = 'x --> <img src=//evil> 	 tab';
    const hostileItems = [{ runId: 'r1', testId: hostile, diagnosis: { category: 'REAL_BUG' } }] as never as Parameters<typeof renderBoardMap>[0];
    const rendered = renderBoardMap(hostileItems, [record(hostile, ERROR)]);
    assert.equal(rendered.indexOf('-->'), rendered.length - 3, 'the only comment close is the real one');
    assert.equal(parseBoardMap(rendered).get(1)?.testId, hostile);
  });
});

describe('review fixes: corrections match what the person saw', () => {
  const items = [
    { runId: 'r1', testId: TEST, diagnosis: { category: 'ENV' } },
    { runId: 'r1', testId: 'shop.spec.ts > other test', diagnosis: { category: 'TIMING' } },
  ] as never as Parameters<typeof renderBoardMap>[0];
  const records = [record(TEST, ERROR), record('shop.spec.ts > other test', 'Error: another thing')];
  const bot = (body: string) => ({ id: 1, body, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', created_at: '2026-01-01T09:00:00Z', html_url: '' });
  const reply = (body: string, at: string) => ({ id: 2, body, user: { login: 'amina', type: 'User' }, author_association: 'MEMBER', created_at: at, html_url: '' });

  it('ignores a reply written before the current numbering was made: it referred to an older one', async () => {
    const comments = [bot(`${commentMarker('')}
${renderBoardMap(items, records, '2026-01-02T00:00:00Z')}`), reply('/triage TEST_DATA #1 old reply', '2026-01-01T12:00:00Z')];
    assert.deepEqual(await readCorrections({ request: async () => comments } as unknown as GitHub, 7, 'PR #7'), []);
  });

  it("maps the failure's last attempt, the one that is diagnosed", () => {
    const attempts = [{ ...record(TEST, 'Error: first attempt'), retry: 0 }, { ...record(TEST, ERROR), retry: 1 }];
    const map = parseBoardMap(renderBoardMap(items.slice(0, 1), attempts, '2026-01-01T09:00:00Z'));
    assert.equal(map.get(1)?.errorShape, errorShape(ERROR));
  });

  it('reads every page of a long discussion', async () => {
    const filler = Array.from({ length: 100 }, (_, n) => reply(`just talking ${n}`, '2026-01-01T10:00:00Z'));
    const pages = [[bot(`${commentMarker('')}
${renderBoardMap(items, records, '2026-01-01T09:00:00Z')}`), ...filler.slice(1)], [reply('/triage TEST_DATA #1 late reply', '2026-01-03T00:00:00Z')]];
    let page = 0;
    const github = { request: async () => pages[page++] ?? [] } as unknown as GitHub;
    const [c] = await readCorrections(github, 7, 'PR #7');
    assert.equal(c?.category, 'TEST_DATA');
  });
});

// Phase 74: the hierarchy the whole product rests on - what the team decided beats what the tool
// decided - tested end to end for the first time.
//
// Field-tested on eight real LOCATOR_DRIFT diagnoses that `explain` had written. Three were corrected
// to TIMING by name, `tewip learn` reported the pattern perfectly ("3x said LOCATOR_DRIFT, you said
// TIMING... Rules that decided them: locator-drift 3x"), and the weekly note a lead reads still said
// **"Diagnosis: LOCATOR_DRIFT, confidence 0.95, source: rules"** about a test somebody had overruled -
// directly against what `correct` prints in the same breath: "Tewip will answer with your decision
// the next time that test fails the same way, and say it was yours."
describe('a correction against a diagnosis already stored', () => {
  const stored = (testId: string, category: string): TriageRecord =>
    ({ ...record(testId, 'TimeoutError: locator.click: Timeout 1500ms exceeded'), diagnosis: { category, confidence: 0.95, source: 'rules rules-3', evidence: [], engineVersion: 'rules-3', diagnosedAt: '2026-01-01T00:00:00Z' } }) as unknown as TriageRecord;

  const correction = (testId: string): Correction => ({
    schemaVersion: 1,
    testId,
    errorShape: errorShape('TimeoutError: locator.click: Timeout 1500ms exceeded'),
    category: 'TIMING',
    wasCategory: 'LOCATOR_DRIFT',
    by: 'sam',
    at: '2026-01-02T00:00:00Z',
    reason: 'the element is there, the page is just slow',
  }) as unknown as Correction;

  const build = async (corrections: Correction[]) => {
    const records = [stored('shop > corrected', 'LOCATOR_DRIFT'), stored('shop > untouched', 'LOCATOR_DRIFT')];
    const runs = [summary('r1', ['shop > corrected', 'shop > untouched'])];
    return buildItems(records, new HistoryIndex(records, runs), { dataset: 'test', llm: null, reuseStoredDiagnoses: true, corrections });
  };

  it('answers with the decision a person made, not the stored one', async () => {
    // `diagnosePipeline` applies corrections only to failures with no stored diagnosis, and `explain`
    // stores one for every failure it diagnoses - so on any history a team actually keeps, a
    // correction reached nothing at all.
    const items = await build([correction('shop > corrected')]);
    const corrected = items.find((i) => i.testId === 'shop > corrected');
    assert.equal(corrected?.diagnosis.category, 'TIMING');
    assert.match(corrected?.source ?? '', /person/, 'and it says a person decided it');
  });

  it('leaves a failure nobody corrected exactly as it was', async () => {
    const items = await build([correction('shop > corrected')]);
    assert.equal(items.find((i) => i.testId === 'shop > untouched')?.diagnosis.category, 'LOCATOR_DRIFT');
  });

  it('changes nothing when there are no corrections', async () => {
    const items = await build([]);
    assert.deepEqual(items.map((i) => i.diagnosis.category), ['LOCATOR_DRIFT', 'LOCATOR_DRIFT']);
  });

  it('does not apply a correction written for a different error', async () => {
    const elsewhere = { ...correction('shop > corrected'), errorShape: errorShape('Error: something else entirely') } as Correction;
    const items = await build([elsewhere]);
    assert.equal(items.find((i) => i.testId === 'shop > corrected')?.diagnosis.category, 'LOCATOR_DRIFT', 'the same test failing another way is another failure');
  });
});
