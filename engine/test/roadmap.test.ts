// Phase 184: a plan that stopped a hundred phases ago, and did not say so.
//
// ROADMAP.md is the document somebody opens to find out where this project is. Its phase log ends
// at Phase 83 and the work continued to 183, with the hundred phases between them recorded only in
// the commit history. Nothing in the file said that, so it read as current.
//
// That is the defect this project spends its phases hunting elsewhere, in its own planning
// document: something stale that looks exactly like something current. The fix is a section saying
// where the log stops. These tests are what keep that section from going stale in its turn - a
// marker that names the wrong phase would be worse than no marker, because it would look checked.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf } from '../lines.ts';

const ROADMAP = lf(readFileSync(join(import.meta.dirname, '..', '..', 'ROADMAP.md'), 'utf8'));

/** Every `### Phase N:` heading in the log, as numbers. */
const documented = [...ROADMAP.matchAll(/^### Phase (\d+)[:.]/gm)].map((m) => Number(m[1]));

describe('the roadmap says where its own log stops', () => {
  it('has the section at all', () => {
    assert.match(ROADMAP, /^## Where this log stops$/m, 'without it the file reads as a current plan');
  });

  it('names the last phase it actually documents', () => {
    const last = Math.max(...documented);
    const claimed = /phase log above ends at Phase (\d+)/i.exec(ROADMAP);
    assert.ok(claimed, 'the section has to name the phase the log ends at, not gesture at it');
    assert.equal(
      Number(claimed[1]),
      last,
      `the log's last documented phase is ${last} and the marker claims ${claimed[1]}. ` +
        'A marker naming the wrong phase is worse than none, because it looks checked.',
    );
  });

  it('sends the reader somewhere that is actually current', () => {
    const section = ROADMAP.slice(ROADMAP.indexOf('## Where this log stops'));
    assert.match(section, /git log/, 'the commit history is where the phases since then are');
    assert.match(section, /engine\/measured\.ts/, 'and the figures with the harnesses that re-derive them');
  });

  it('does not quietly disown the parts that are still in force', () => {
    // The risk of admitting one part is stale is that a reader discounts the whole file. The
    // design principles and the anti-scope-creep rules still govern - Phase 178 and Phase 183 were
    // both argued from principle 4 - so the section has to say which parts those are.
    const section = ROADMAP.slice(ROADMAP.indexOf('## Where this log stops'));
    assert.match(section, /not\*\* stale/, 'the section must say which parts still hold');
    for (const heading of ['## Anti-Scope-Creep Rules', '## Reality Check Gate', '## Working Agreement']) {
      assert.ok(ROADMAP.includes(heading), `${heading} is referred to as still in force and is not in the file`);
    }
  });

  it('keeps the phase log a log: no gaps claimed as documented', () => {
    // There is no Phase 20 in this file - the planned run goes 19 then 21. That is a fact about
    // the numbering, not an error, and this records it so a future reader does not go looking for
    // a section that never existed.
    assert.ok(!documented.includes(20), 'Phase 20 has never existed in this roadmap');
    assert.ok(documented.includes(19) && documented.includes(21), 'the planned run goes 19 then 21');
  });
});
