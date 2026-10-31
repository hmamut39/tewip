// Phase 124: the page an IT department reads before letting an agent near a repository.
//
// Every other agent's version of this is a list of reassurances: the reader cannot verify one of
// them and the author cannot be held to any. So each promise here names the test that enforces
// it, and the page is rendered by reading those tests off disk. A promise whose test is gone is
// printed as no longer enforced - the page can embarrass this project, which is the only kind of
// safety document worth publishing.
//
// These tests exist because a safety page that lies is worse than none, and there are exactly two
// ways for this one to lie: claim a promise nobody enforces, and count something it did not
// measure. Both were present in the first version and both were caught by running it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROMISES, checkPromises } from '../safety/safety.ts';
import { renderSafety } from '../safety/safety-command.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const NL = String.fromCharCode(10);

describe('the safety card', () => {
  it('every promise it makes is enforced by a test that really exists', () => {
    // The whole point. If this fails, either a test was renamed or a promise was written that
    // nothing backs - and the second is the one that matters.
    const unenforced = checkPromises(ROOT).filter((c) => !c.enforced);
    assert.deepEqual(
      unenforced.map((c) => `${c.file} -> ${c.test}`),
      [],
      'a promise on the safety card with no test behind it is exactly the unverifiable reassurance this page exists to replace',
    );
    assert.ok(PROMISES.length >= 8, `only ${PROMISES.length} promises; this page is meant to cover the agent's real powers`);
  });

  it('says so in the page when a promise stops being enforced, rather than dropping it', () => {
    const page = renderSafety(
      [
        { claim: 'Tewip puts your file back.', because: 'An unverified edit is indistinguishable from a deliberate one.', file: 'engine/test/gone.test.ts', test: 'a test nobody wrote', enforced: false },
        { claim: 'Tewip stays in the sandbox.', because: 'Reach matters.', file: 'engine/test/autofix.test.ts', test: 'never edits a file outside the sandbox', enforced: true },
      ],
      { kept: 0, decided: 0, undecided: 0 },
    );
    assert.match(page, /NO LONGER ENFORCED/);
    assert.match(page, /1 of 2 promises are enforced/);
    assert.match(page, /1 promise\(s\) on this page are not currently enforced/);
    assert.match(page, /Tewip puts your file back/, 'the promise is still shown, marked, not quietly removed');
  });

  it('does not count a failure nobody has judged as a failure Tewip refused', () => {
    // The first version of this page said "declined to put a cause on 1305 of 1305 (100.0%)" -
    // which reads as a tool that explains nothing. The collection path stores a raw failure and
    // works out the cause when a report is rendered, so a record with no diagnosis has not been
    // refused; it has not been read. The same mistake Phase 59 found in `recall`, made again in
    // the one document where a false number does the most damage.
    const page = renderSafety([], { kept: 1305, decided: 0, undecided: 0 });
    assert.doesNotMatch(page, /100\.0%/);
    assert.doesNotMatch(page, /declined to name a cause for 1305/);
    assert.match(page, /none of them carries a decision, so there is nothing to count yet/);
  });

  it('counts refusals against what was judged, not against what was stored', () => {
    const page = renderSafety([], { kept: 100, decided: 40, undecided: 10 });
    assert.match(page, /declined to name a cause for 10 \(25\.0%\)/, '10 of the 40 judged, not 10 of the 100 kept');
    assert.match(page, /60 more are stored but not yet judged/, 'and the gap is accounted for rather than hidden');
  });

  it('names what it does not cover, including the one command that edits application code', () => {
    const page = renderSafety(checkPromises(ROOT), { kept: 0, decided: 0, undecided: 0 });
    assert.match(page, /What this page does not cover/);
    assert.match(page, /tewip fix --code/, 'the riskiest command must be named on the safety page, not omitted from it');
    assert.match(page, /An absence here is not a promise/);
  });

  it('reads a promise as enforced only from a real test, never from a comment', () => {
    // A title that appears in prose would make the page self-congratulating on its own words.
    const root = mkdtempSync(join(tmpdir(), 'tewip-safety-'));
    mkdirSync(join(root, 'engine', 'test'), { recursive: true });
    const claim = 'puts the file back';
    writeFileSync(join(root, 'engine', 'test', 'a.test.ts'), `// we really do ${claim}, honestly${NL}`, 'utf8');
    const [checked] = checkPromises(root, [{ claim: 'c', because: 'b', file: 'engine/test/a.test.ts', test: claim }]);
    assert.equal(checked.enforced, false, 'a sentence in a comment is not a test');

    writeFileSync(join(root, 'engine', 'test', 'a.test.ts'), `it('${claim}', () => {});${NL}`, 'utf8');
    assert.equal(checkPromises(root, [{ claim: 'c', because: 'b', file: 'engine/test/a.test.ts', test: claim }])[0].enforced, true);
  });
});
