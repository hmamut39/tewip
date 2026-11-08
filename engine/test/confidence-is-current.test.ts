// Every number the evidence pack publishes, re-derived from the harness that produced it.
//
// The pack's whole argument is that each claim carries a measured figure instead of an assurance.
// Those figures lived in `confidence.ts` as prose, and nothing anywhere re-derived them: change a
// rule, and the pack would go on printing "20 of 20 credential shapes found" out of a string
// literal while `eval/secure-recall.ts` returned eighteen. A stated measurement that has silently
// stopped holding, inside a signed document, handed to somebody whose whole reason for reading it
// is that they cannot run the checks themselves. Of every defect this project has gone looking for,
// that is the one it would least be able to explain.
//
// So the harnesses run here. Five of the six are quick - the slowest is two and a half seconds,
// because they plant files and read them. `vouch` is the exception and is excluded deliberately:
// it runs a real test suite and mutates real source to see whether the tests notice, which takes
// minutes rather than seconds. Its row is held to its shape rather than its result, and that is
// stated rather than hidden.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { measure as accessRecall } from '../../eval/access-recall.ts';
import { measure as agentRecall } from '../../eval/agent-recall.ts';
import { measure as guardRecall } from '../../eval/guard-recall.ts';
import { measure as injectionRecall } from '../../eval/injection-recall.ts';
import { measure as schemaRecall } from '../../eval/schema-recall.ts';
import { measure as secureRecall } from '../../eval/secure-recall.ts';
import { MEASURED, type Confidence } from '../evidence/confidence.ts';

interface Counts {
  found: number;
  of: number;
  accused: number;
  decoys: number;
}

/**
 * Each harness, reduced the way its own report reduces it.
 *
 * Deliberately copied from each `report()` rather than re-invented: the published sentence is
 * computed one way, and a test computing it a different way would measure the difference between
 * two readings rather than whether the number still holds.
 */
const HARNESSES: Record<string, () => Counts> = {
  secure: () => {
    const { credentials, decoys } = secureRecall();
    return {
      found: credentials.filter((c) => c.actionable).length,
      of: credentials.length,
      accused: decoys.filter((d) => d.actionable).length,
      decoys: decoys.length,
    };
  },
  schema: () => {
    const { dangerous, safe } = schemaRecall();
    return {
      found: dangerous.filter((d) => d.right).length,
      of: dangerous.length,
      accused: safe.filter((s) => s.expect.some((h) => s.found.includes(h))).length,
      decoys: safe.length,
    };
  },
  access: () => {
    const all = accessRecall();
    return {
      found: all.filter((m) => m.noticed).length,
      of: all.length,
      accused: all.filter((m) => m.accused).length,
      decoys: all.length,
    };
  },
  agent: () => {
    const { frameworks, decoys } = agentRecall();
    return {
      found: frameworks.filter((f) => f.found).length,
      of: frameworks.length,
      accused: decoys.filter((d) => d.found).length,
      decoys: decoys.length,
    };
  },
  guard: () => {
    const { frameworks, decoys } = guardRecall();
    return {
      found: frameworks.filter((f) => f.found).length,
      of: frameworks.length,
      accused: decoys.filter((d) => d.found).length,
      decoys: decoys.length,
    };
  },
  injection: () => {
    const { flows, decoys } = injectionRecall();
    return {
      found: flows.filter((f) => f.found).length,
      of: flows.length,
      accused: decoys.filter((d) => d.found).length,
      decoys: decoys.length,
    };
  },
};

/** Which harness backs a row, from the file it names rather than from a second list. */
const harnessFor = (row: Confidence): (() => Counts) | undefined => HARNESSES[row.from.replace(/^eval\/|-recall\.ts$/g, '')];

describe('every number the evidence pack publishes', () => {
  it('names a harness this test can run, or says why not', () => {
    const unrunnable = MEASURED.filter((row) => !harnessFor(row)).map((row) => row.from);
    assert.deepEqual(unrunnable, ['eval/vouch-recall.ts'], `a row names a harness nothing re-derives: ${unrunnable.join(', ')}`);
  });

  for (const row of MEASURED) {
    const harness = harnessFor(row);
    if (!harness) continue;

    it(`still holds for ${row.check}`, () => {
      const now = harness();
      assert.deepEqual(
        now,
        row.measured,
        `${row.check} publishes ${JSON.stringify(row.measured)} but ${row.from} now returns ${JSON.stringify(now)}. ` +
          'Re-run that harness, check the change is one you meant, and update confidence.ts - the pack is printing this number to people who cannot check it.',
      );
    });

    it(`has prose matching its counts for ${row.check}`, () => {
      // The sentence is what a reader sees; the counts are what this test can check. If they drift
      // apart the reader is being shown the wrong one.
      assert.ok(
        row.recall.includes(`${row.measured.found} of ${row.measured.of}`),
        `${row.check} says "${row.recall}" but its counts are ${row.measured.found} of ${row.measured.of}`,
      );
      if (row.measured.decoys > 0) {
        assert.ok(
          row.recall.includes(`${row.measured.accused} of ${row.measured.decoys}`) || row.precision.includes(`${row.measured.accused} of ${row.measured.decoys}`),
          `${row.check} never states how many of its ${row.measured.decoys} decoys it accused`,
        );
      }
    });
  }

  it('claims no perfect recall it cannot show', () => {
    for (const row of MEASURED) {
      assert.ok(row.measured.found <= row.measured.of, `${row.check} claims to find more than it looked for`);
      assert.ok(row.measured.of > 0, `${row.check} measured nothing`);
    }
  });
});
