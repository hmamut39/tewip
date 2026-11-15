// Phase 181: every check the evidence pack runs has to account for itself.
//
// `confidenceSection` prints a row for each check in MEASURED and a line for each in NOT_MEASURED,
// filtered to the ones that actually ran. A check in neither list prints nothing - and in a report
// whose whole purpose is to say how much each line is worth, a check with no honesty line reads
// exactly like one that passed with a measured recall behind it.
//
// `audit` was in neither for the eleven phases it had been part of the pack. It was not hidden by
// anything; it was simply never added, and nothing could notice because the rendering of a missing
// entry is silence. That is the same shape as the stale channel that looks like a current one, and
// as the figure in prose with no harness behind it: the absence is invisible at the point it
// matters.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MEASURED, NOT_MEASURED, confidenceSection } from '../evidence/confidence.ts';
import { CHECKS } from '../evidence/render.ts';

describe('every check in the evidence pack accounts for itself', () => {
  it('is in the measured table or the named exceptions, never in neither', () => {
    const measured = new Set(MEASURED.map((m) => m.command));
    const excused = new Set(NOT_MEASURED.map((m) => m.check));
    const orphans = [...new Set(CHECKS.map((c) => c.command))].filter((c) => !measured.has(c) && !excused.has(c));
    assert.deepEqual(
      orphans,
      [],
      `${orphans.join(', ')} run in the evidence pack but carry neither a measured recall nor a stated reason for having none. ` +
        'A check in neither list prints no line, and no line reads as a clean one.',
    );
  });

  it('is not in both, which would print two different answers for one check', () => {
    const excused = new Set(NOT_MEASURED.map((m) => m.check));
    const both = MEASURED.map((m) => m.command).filter((c) => excused.has(c));
    assert.deepEqual(both, [], `${both.join(', ')} claims a measured recall and an excuse for having none`);
  });

  it('gives every excused check a reason, not just a name', () => {
    for (const m of NOT_MEASURED) {
      assert.ok(m.why.length > 40, `${m.check} is excused without saying why in any useful detail`);
      assert.ok(!/^(not measured|todo|tbd)/i.test(m.why.trim()), `${m.check}'s reason says nothing`);
    }
  });

  it('actually prints the excused checks that ran, by name', () => {
    // The guard above is about the data. This is about the rendering, because a complete list that
    // nothing prints would satisfy the first test and still show the reader nothing.
    const section = confidenceSection(['audit']).join('\n');
    assert.match(section, /Carrying no measured recall/, 'an unmeasured check that ran has to say so in the report');
    assert.match(section, /`audit`/, 'and be named');
  });

  it('says nothing about a check that did not run', () => {
    assert.deepEqual(confidenceSection([]), [], 'a pack that ran nothing claims nothing');
    const section = confidenceSection(['audit']).join('\n');
    assert.doesNotMatch(section, /`schema`/, 'a check that did not run must not appear');
  });

  it('keeps every measured row re-derivable', () => {
    for (const m of MEASURED) {
      assert.ok(m.from && m.from.length > 0, `${m.check} publishes a recall with no harness that re-derives it`);
      assert.ok(m.measured.found <= m.measured.of, `${m.check} claims to have found more than it looked for`);
      assert.ok(m.measured.accused <= m.measured.decoys, `${m.check} claims more false accusations than it had decoys`);
    }
  });
});
