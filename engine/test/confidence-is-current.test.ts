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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { measure as accessRecall } from '../../eval/access-recall.ts';
import { measure as agentRecall } from '../../eval/agent-recall.ts';
import { measure as containerRecall } from '../../eval/container-recall.ts';
import { measure as guardRecall } from '../../eval/guard-recall.ts';
import { measure as memoryRecall } from '../../eval/memory-recall.ts';
import { measure as identityRecall } from '../../eval/identity-recall.ts';
import { measure as doorRecall } from '../../eval/door-recall.ts';
import { measure as goalRecall } from '../../eval/goal-recall.ts';
import { measure as infraRecall } from '../../eval/infra-recall.ts';
import { measure as terraformRecall } from '../../eval/terraform-recall.ts';
import { measure as injectionRecall } from '../../eval/injection-recall.ts';
import { measure as schemaRecall } from '../../eval/schema-recall.ts';
import { measure as secureRecall } from '../../eval/secure-recall.ts';
import { MEASURED, type Confidence } from '../evidence/confidence.ts';
import { lf } from '../lines.ts';

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
  terraform: () => {
    const all = terraformRecall();
    return { found: all.filter((m) => m.noticed).length, of: all.length, accused: all.filter((m) => m.accused).length, decoys: all.length };
  },
  container: () => {
    const all = containerRecall();
    return { found: all.filter((m) => m.noticed).length, of: all.length, accused: all.filter((m) => m.accused).length, decoys: all.length };
  },
  infra: () => {
    const all = infraRecall();
    return {
      found: all.filter((m) => m.noticed).length,
      of: all.length,
      accused: all.filter((m) => m.accused).length,
      decoys: all.length,
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
  goal: () => {
    const { goals, turns } = goalRecall();
    const reachable = goals.filter((g) => g.flow);
    return {
      found: reachable.filter((g) => g.goal).length,
      of: reachable.length,
      accused: turns.filter((t) => t.goal).length,
      decoys: turns.length,
    };
  },
  door: () => {
    const { doors, decoys } = doorRecall();
    return {
      found: doors.filter((d) => d.found).length,
      of: doors.length,
      accused: decoys.filter((d) => d.found).length,
      decoys: decoys.length,
    };
  },
  identity: () => {
    const { flows, decoys } = identityRecall();
    return {
      found: flows.filter((f) => f.found).length,
      of: flows.length,
      accused: decoys.filter((d) => d.found).length,
      decoys: decoys.length,
    };
  },
  memory: () => {
    const { flows, decoys } = memoryRecall();
    return {
      found: flows.filter((f) => f.found).length,
      of: flows.length,
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

// Phase 155: the precision half of the table, which nothing re-derived either.
//
// `recall` is held to its harness above. A precision sentence - "0 findings across 18,617 files of
// real code" - is only as current as the last person who happened to run the thing, and three
// phases of changes to `agent` went in against one. Where a figure comes from the corpus, the row
// now names the repositories it was read on, and `npm run corpus` re-derives it. This holds that
// list to the corpus file: a row cannot claim a repository that does not pin that command.
describe('where a precision figure is pinned', () => {
  const corpus = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'corpus', 'expected.json'), 'utf8')) as {
    repos: Array<{ name: string; checks: Array<{ command: string }> }>;
  };
  // The verb and the corpus check share a name everywhere but one: the command is `tewip secure`
  // and the corpus has always called that check `secrets`. Mapped here rather than renamed, because
  // the name in corpus/expected.json is part of a pinned record going back to Phase 127.
  const CORPUS_NAME: Record<string, string> = { secure: 'secrets' };
  const pinned = (command: string) => {
    const name = CORPUS_NAME[command] ?? command;
    return corpus.repos.filter((r) => r.checks.some((c) => c.command === name)).map((r) => r.name);
  };

  for (const row of MEASURED.filter((r) => r.pinnedIn)) {
    it(`is really in the corpus for ${row.check}`, () => {
      const actually = pinned(row.command);
      const claimed = row.pinnedIn ?? [];
      const missing = claimed.filter((name) => !actually.includes(name));
      assert.deepEqual(
        missing,
        [],
        `${row.check} says its precision is pinned on ${missing.join(', ')}, and corpus/expected.json has no ${row.command} check for those. ` +
          'The sentence in the pack would be claiming a measurement nobody takes.',
      );
      assert.equal(claimed.length, actually.length, `${row.check} claims ${claimed.length} pinned repositories and the corpus has ${actually.length} for ${row.command}`);
    });
  }

  it('says plainly which figures are not pinned at all', () => {
    // These rows count their own decoys, which the test above re-derives, so they need no corpus.
    // Any other unpinned row is a precision claim with nothing behind it. The list is named rather
    // than counted: a comment saying "the two rows" is the same stale-by-omission shape this file
    // exists to catch, and it had already drifted to three before anyone looked.
    const unpinned = MEASURED.filter((r) => !r.pinnedIn).map((r) => r.check);
    assert.deepEqual(
      unpinned,
      ['infra (Terraform)', 'infra (Docker)', 'agent (the guards)', 'agent (memory poisoning)', 'agent (an interface others can reach)', 'agent (goal hijack)', 'agent (prompt-injection flows)'],
      `these precision figures are neither pinned nor counted from decoys: ${unpinned.join(', ')}`,
    );
  });
});

// Phase 164: the README's own table of measured checks, held to the one the pack prints.
//
// It listed five checks under the heading "Every check now has a recall number" while
// confidence.ts carried eight: `infra`, `agent (the guards)` and `agent (prompt-injection flows)`
// had all been measured since, and the table said nothing about them. Stale by omission is still
// stale - the sentence was true when it was written and had nothing re-deriving it, which is the
// shape of every defect found this week.
describe("the README's table of measured checks", () => {
  const readme = lf(readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8'));

  it('lists every check that carries a measured number', () => {
    const table = /\| check \| precision \| recall \|[\s\S]*?\n\n/.exec(readme);
    assert.ok(table, 'the README no longer has a table of measured checks');
    const missing = MEASURED.filter((row) => !table[0].includes(`\`${row.check}\``)).map((r) => r.check);
    assert.deepEqual(
      missing,
      [],
      `confidence.ts measures ${missing.join(', ')} and the README's table does not mention them. A reader counting the checks would undercount the work.`,
    );
  });

  it('lists no check that carries no number', () => {
    const table = /\| check \| precision \| recall \|[\s\S]*?\n\n/.exec(readme)![0];
    const listed = [...table.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
    const known = new Set(MEASURED.map((r) => r.check));
    const invented = listed.filter((name) => !known.has(name));
    assert.deepEqual(invented, [], `the README's table claims a measured number for ${invented.join(', ')}, which nothing measures`);
  });
});
