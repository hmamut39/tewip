// Phase 114: what recall counts, and what it refuses to count.
//
// Two defects of one family, both found by asking the real gutenberg history a real question.
//
// The first: Playwright writes every retry of a failing test as its own record, and nothing
// downstream knew. Asked about a real error, recall answered "5 earlier failure(s) look like this
// one" where four were the same test and three were the same run on the same day - one event,
// counted three times, filling the slots the rest of the history should have had. The footer
// compounded it: "Searched 1053 diagnosed failure(s)" for a project holding 596 distinct ones.
// 480 of gutenberg's 1,053 kept failures (46%) are retry copies; 126 of supabase's 903 (14%).
//
// The second: a word the history has never contained was weighted 1 - the lowest weight in the
// scheme, the one for a word in every single failure. Asked "the VAT column on the quarterly
// invoice PDF is rounded down", a question with nothing to do with the project, recall returned
// five confident matches on the strength of "column" appearing in columns.spec.js.
//
// Both are the same mistake in different clothes: a number that reads as weight of evidence and
// is really an artefact of how the records were written. Counting is a claim like any other.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memories, recall, renderRecall } from '../recall/recall.ts';
import { oneRowPerFailure } from '../recall/same.ts';
import type { TriageRecord } from '../../reporters/types.ts';

const MISMATCH = 'Error: expect(received).toBe(expected) Expected: "red" Received: "blue"';
const TIMEOUT = "TimeoutError: locator.click: Timeout 10000ms exceeded waiting for getByRole('button')";

const attempt = (
  testId: string,
  error: string,
  { runId = 'r1', retry = 0, category = 'REAL_BUG', when = '2026-09-01T00:00:00.000Z' } = {},
): TriageRecord =>
  ({
    schemaVersion: 1, testId, file: 'tests/a.spec.ts', status: 'failed', errorMessage: error, errorStack: '',
    duration: 1, retry, attachments: [], runId, gitSha: 'abc1234', timestamp: when,
    diagnosis: { category, confidence: 0.8, source: 'rules', evidence: [] },
  }) as unknown as TriageRecord;

describe('one failure recorded three times is one failure', () => {
  it('folds the retries of a failure into the failure, and keeps how many there were', () => {
    const kept = memories([0, 1, 2].map((retry) => attempt('cart > totals', MISMATCH, { retry })));
    assert.equal(kept.length, 1, 'three attempts at one failure are one thing that happened');
    assert.equal(kept[0].attempts, 3, 'and the three are not discarded: a test that failed every attempt is not behaving like a flake');
  });

  it('keeps a retry that failed a different way, because that is a second thing to know', () => {
    const kept = memories([
      attempt('cart > totals', MISMATCH, { retry: 0 }),
      attempt('cart > totals', TIMEOUT, { retry: 1 }),
    ]);
    assert.equal(kept.length, 2, 'same run, same test, two different errors: two memories');
  });

  it('counts what it searched in failures, not in records', () => {
    // This number is printed as "Searched N diagnosed failure(s)". On the real history it read
    // 1053 for 596 distinct failures: the footer agreeing with the inflated body.
    assert.equal(memories([0, 1, 2].map((retry) => attempt('cart > totals', MISMATCH, { retry }))).length, 1);
  });

  it('carries a correction off the attempt it happened to be recorded against', () => {
    // A correction is matched by test and error shape, so it lands on every attempt alike. What
    // this guards is that folding never drops one. Built by hand because the fold is what is
    // under test here, not the matching.
    const folded = oneRowPerFailure([
      { testId: 'cart > totals', category: 'REAL_BUG', decidedBy: 'rules', when: '2026-09-01T00:00:00.000Z', runId: 'r1', error: MISMATCH, full: MISMATCH },
      { testId: 'cart > totals', category: 'ENV', decidedBy: 'dana (a person)', when: '2026-09-01T00:00:00.000Z', runId: 'r1', error: MISMATCH, full: MISMATCH, correctedBy: 'dana', correctionReason: 'the fixture has stale prices' },
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].correctedBy, 'dana', 'the most valuable memory there is must not be folded away');
    assert.equal(folded[0].category, 'ENV', 'and what the person decided is what the memory says');
  });
});

describe('one problem seen in four runs is one problem', () => {
  const fourRuns = (): TriageRecord[] =>
    ['r1', 'r2', 'r3', 'r4'].flatMap((runId, i) =>
      [0, 1, 2].map((retry) => attempt('cart > totals', MISMATCH, { runId, retry, when: `2026-09-0${i + 1}T00:00:00.000Z` })),
    );

  it('says it once, with the runs and the dates it spanned', () => {
    const found = recall(MISMATCH, memories(fourRuns()));
    assert.equal(found.length, 1, 'four runs of one problem is one row');
    assert.equal(found[0].occurrences, 4, 'and all four runs are still counted');
    assert.equal(found[0].attempts, 12, 'as are all twelve attempts');
    const report = renderRecall(MISMATCH, found);
    assert.match(report, /Seen in 4 separate run\(s\), 2026-09-01 to 2026-09-04/);
    assert.match(report, /Failed 12 time\(s\) in those run\(s\), retries counted/);
    assert.doesNotMatch(report, /12 earlier problem/, 'the headline counts problems, never records');
  });

  it('groups before the limit, not after', () => {
    // The point of grouping. Ungrouped, one recurring problem took four of the five slots and the
    // rest of the project's history was never shown. Grouping after the cut would be worse than
    // either: one row, and the other history still thrown away.
    const history = memories([
      ...fourRuns(),
      attempt('checkout > pays', 'Error: expect(received).toBe(expected) Expected: "paid" Received: "pending"', { runId: 'r9', category: 'ENV' }),
    ]);
    const found = recall('Error: expect(received).toBe(expected) Expected Received', history, { limit: 2 });
    assert.equal(found.length, 2);
    assert.deepEqual(
      [...new Set(found.map((f) => f.testId))].sort(),
      ['cart > totals', 'checkout > pays'],
      'two slots, two different problems',
    );
  });

  it('says so when the earlier decisions disagree with each other', () => {
    const found = recall(MISMATCH, memories([
      attempt('cart > totals', MISMATCH, { runId: 'r1', category: 'REAL_BUG' }),
      attempt('cart > totals', MISMATCH, { runId: 'r2', category: 'REAL_BUG' }),
      attempt('cart > totals', MISMATCH, { runId: 'r3', category: 'UNKNOWN' }),
    ]));
    assert.equal(found.length, 1);
    assert.equal(found[0].disagreed, '2 x REAL_BUG, 1 x UNKNOWN');
    const report = renderRecall(MISMATCH, found);
    assert.match(report, /The earlier decisions do not agree:\*\* 2 x REAL_BUG, 1 x UNKNOWN/);
    assert.match(report, /no single earlier conclusion to follow/, 'the reader is told not to follow one');
  });

  it('stays quiet about agreement when every run was decided the same way', () => {
    const found = recall(MISMATCH, memories(fourRuns()));
    assert.equal(found[0].disagreed, undefined);
    assert.doesNotMatch(renderRecall(MISMATCH, found), /do not agree/);
  });
});

describe('a word this project has never seen is the rarest word there is', () => {
  const ASKED = 'the VAT columns on the quarterly invoice PDF is rounded down';
  // Seven words survive the stop list, of which six - vat, quarterly, invoice, pdf, rounded, down
  // - appear nowhere in this history, and one, "columns", appears in two of its twenty failures.
  //
  // The size is not decoration. The first version of this guard used a two-record history, where
  // log(total/n) cannot grow large enough for anything to clear the 0.15 bar, so it passed against
  // the unfixed code and proved nothing whatsoever. At twenty records with the word in two of
  // them, weighting an unseen word 1 scores this 0.355 and weighting it log(2N)+1 scores it 0.105.
  // On the real gutenberg history, where "column" appears in 4 of 596 failures, the same two
  // weightings score it 0.365 and 0.116: the same bar crossed and the same bar missed.
  const UNRELATED = [
    'serialisation', 'pagination', 'thumbnail', 'webhook', 'cursor', 'palette', 'gradient',
    'sidebar', 'anchor', 'embed', 'caption', 'duotone', 'shortcode', 'widget', 'glossary',
    'patternbar', 'reusable',
  ];
  const history = () =>
    memories([
      attempt('editor > columns > should arrow up into empty columns', 'Error: expect(received).toMatchObject(expected) Array [ Object { "innerBlocks"', { runId: 'r1' }),
      attempt('editor > columns > selects on backspace when non-empty', 'Error: expect(received).toMatchObject(expected) Array [ Object { "attributes"', { runId: 'r2' }),
      attempt('editor > blocks > waits for the inserter', TIMEOUT, { runId: 'r3' }),
      ...UNRELATED.map((word, i) => attempt(`editor > ${word} > keeps its value`, `Error: the ${word} assertion did not hold`, { runId: `f${i}` })),
    ]);

  it('does not answer a question about something else on the strength of one shared word', () => {
    // The real question that exposed it, asked of a project that has never seen an invoice.
    const kept = history();
    assert.equal(kept.length, 20, 'the arithmetic above depends on this being a real-sized history');
    const found = recall(ASKED, kept);
    assert.deepEqual(found, [], 'one word in common with columns.spec.js is not a memory of this');
    assert.match(renderRecall(ASKED, found, 20), /Nothing in the 20 diagnosed failure\(s\) kept here resembles it/);
  });

  it('still finds the history when the question is genuinely about it', () => {
    // The guard above must not be bought by making recall deaf. Same history, and a question that
    // really is about it.
    const found = recall('TimeoutError: locator.click: Timeout 30000ms exceeded waiting for getByRole', history());
    assert.equal(found.length, 1, 'the timeout is still recalled');
    assert.match(found[0].testId, /waits for the inserter/);
  });
});
