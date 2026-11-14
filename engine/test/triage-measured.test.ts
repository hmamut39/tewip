// The triage engine's own numbers, held to the harness that produced them.
//
// Every check in this product has its recall re-derived in CI. The triage engine had one overall
// figure and a report footer that pointed at a file instead of naming it, so the number nobody
// could see was the number nobody checked - for longer than any other claim here.
//
// `eval/triage-recall.ts` re-derives the table, but it diagnoses 2,358 failures across seven
// datasets and takes minutes, which is too slow for this suite. So the figures live in
// engine/measured.ts as a record with its provenance, the way corpus/expected.json does, and what
// this file guards is that the sentence a reader sees still matches that record, and that the
// record still describes a measurement rather than a hope.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TRIAGE_CASES, TRIAGE_FOUND, TRIAGE_MISREAD, TRIAGE_REFUSED, TRIAGE_RECALL, triageReliability } from '../measured.ts';
import { sourceNote } from '../../outlets/view.ts';

describe('what a triage report says about its own reliability', () => {
  it('names every category rather than one average', () => {
    // The average was what hid the answer: 1,682 of 2,358 cases are TIMING, so an engine that
    // recognised nothing else would still score near 70%.
    const line = triageReliability();
    for (const c of TRIAGE_RECALL) assert.ok(line.includes(c.category), `${c.category} is missing from the line a reader sees`);
  });

  it('puts the weakest number in front of the reader, not in a file somewhere', () => {
    const note = sourceNote('data/real/example');
    assert.match(note, /14% of REAL_BUG/, 'the weakest figure has to be in the report, not behind a link');
    assert.doesNotMatch(note, /see eval\/README\.md/, 'a pointer is how a weak number stays unread');
  });

  it('says the misses are refusals, because that is the half that makes the rest survivable', () => {
    assert.match(triageReliability(), /UNKNOWN rather than guessing/);
    assert.match(triageReliability(), /refusal, not a wrong cause/);
  });

  it('names the harness that re-derives it', () => {
    assert.match(triageReliability(), /node eval\/triage-recall\.ts/);
  });

  it('records a measurement, not a hope', () => {
    for (const c of TRIAGE_RECALL) {
      assert.ok(c.of > 0, `${c.category} claims a rate over no cases`);
      assert.ok(c.found <= c.of, `${c.category} claims to find more than it looked for`);
      // Every miss is one or the other. If these stop adding up the record has been edited by hand
      // rather than re-derived, which is the failure this file exists to catch.
      assert.equal(c.found + c.refused + c.misread, c.of, `${c.category} does not add up: its misses are unaccounted for`);
    }
    assert.equal(TRIAGE_FOUND + TRIAGE_REFUSED + TRIAGE_MISREAD, TRIAGE_CASES);
  });

  it('still shows refusals outnumbering wrong causes, which is the whole claim', () => {
    // If this ever flips, the engine has started guessing where it used to decline, and the
    // sentence above stops being true before anybody notices the recall moved.
    assert.ok(
      TRIAGE_REFUSED > TRIAGE_MISREAD * 3,
      `refusals ${TRIAGE_REFUSED} vs wrong causes ${TRIAGE_MISREAD}: the engine is now misleading more often than it declines`,
    );
  });
});
