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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCURACY_RANGE, DATASET_ACCURACY, TRIAGE_CASES, TRIAGE_FOUND, TRIAGE_MISREAD, TRIAGE_REFUSED, TRIAGE_RECALL, accuracyOf, triageReliability } from '../measured.ts';
import { lf } from '../lines.ts';
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

// Phase 174: the README published six accuracy figures and nothing had ever re-derived one.
//
// It said accuracy "ranges from 86.1% to 99.7%". Measured on 14 November 2026, not one of the six
// reproduced. The rules layer had not drifted at all - on the fresh set it was right on 171 of the
// 174 it decided, the same 171 of 174 recorded when the figure was written - and the whole gap was
// the model layer, which decided the other 39 and got 7 right where 93.4% needs about 28.
//
// Nothing could have caught it. The labelled data is gitignored (`data/*`), so no CI job can run
// the measurement, and a reader cloning this repository gets five synthetic labels and an empty
// `data/`. The most prominent number in the document was the least checkable thing in it.
//
// So the figures live in engine/measured.ts with their date and provenance, the README quotes that
// record, and this holds the two together. Re-deriving the record needs the data and takes minutes,
// which is `node eval/dataset-accuracy.ts` and not this suite - stated here rather than implied,
// because a figure whose re-derivation nobody can run is the whole subject of this file.
describe("the README's accuracy figures", () => {
  const readme = lf(readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8'));

  it('quotes the range in the record, not a number of its own', () => {
    const low = accuracyOf(ACCURACY_RANGE.lowest).replace(/\.0%$/, '%');
    const high = accuracyOf(ACCURACY_RANGE.highest).replace(/\.0%$/, '%');
    assert.ok(readme.includes(`**${low}**`), `the record's lowest dataset is ${low} (${ACCURACY_RANGE.lowest.dataset}) and the README does not say so`);
    assert.ok(readme.includes(`**${high}**`), `the record's highest dataset is ${high} (${ACCURACY_RANGE.highest.dataset}) and the README does not say so`);
  });

  it('no longer claims the range that was measured with a model nobody pinned', () => {
    assert.ok(!readme.includes('ranges from 86.1% to 99.7%'), 'that range was measured with the model layer on and does not reproduce');
    assert.ok(!readme.includes('accuracy is 93.4%'), 'that figure does not reproduce: the rules layer is unchanged and the model layer is not');
  });

  it('says that a clean checkout cannot re-derive it', () => {
    // The honest half. Somebody weighing this tool should know which numbers they can check.
    assert.match(readme, /not\*\* re-derivable from a clean checkout/, 'the README should say the labelled data is not in this repository');
    assert.match(readme, /node eval\/dataset-accuracy\.ts/, 'the README should name the harness that re-derives the table');
  });

  it('holds TEAM-GUIDE.md to the same record, not just the README', () => {
    // Phase 172's lesson, applied straight away: a guard that checks one of two copies of a claim
    // leaves the other free to rot and reads in CI exactly like a guard that checks both. The
    // stale 86%-99.7% range was in TEAM-GUIDE.md as well, in a section headed "How good is it,
    // honestly", which is the worst place in the project for it to have been wrong.
    const guide = lf(readFileSync(join(import.meta.dirname, '..', '..', 'TEAM-GUIDE.md'), 'utf8'));
    const low = accuracyOf(ACCURACY_RANGE.lowest).replace(/\.0%$/, '%');
    const high = accuracyOf(ACCURACY_RANGE.highest).replace(/\.0%$/, '%');
    assert.ok(guide.includes(`**${low} to ${high}**`), `TEAM-GUIDE.md should state the measured range ${low} to ${high}`);
    assert.ok(!/right \*\*86% to 99\.7%\*\*/.test(guide), 'TEAM-GUIDE.md still claims the range measured with an unpinned model');
  });

  it('records a measurement, not a hope', () => {
    for (const d of DATASET_ACCURACY) {
      assert.ok(d.of > 0, `${d.dataset} claims a rate over no cases`);
      assert.ok(d.right <= d.of, `${d.dataset} claims more right than it looked at`);
      assert.ok(d.labels.startsWith('eval/') && d.data.startsWith('data/'), `${d.dataset} does not name where it came from`);
    }
  });
});
