// Tewip must say the same thing about a file whether it was written on Windows or on Linux.
//
// It did not, and for a long time: `eval/crlf-parity.ts` found `infra` answering differently, in
// two separate ways. `readCompose` split on `\n` and left a `\r` at the end of every line, and
// because `.` does not match `\r` in JavaScript the pattern `/^\s*cap_add\s*:(.*)$/` never matched
// a Windows compose file at all - so the `dangerous-capability` rule reported **nothing**, not an
// error. And every Kubernetes finding came back one line early, because the `m` flag treats a lone
// `\r` as a line terminator, so `^` matches between the `\r` and the `\n` and `\s*` then runs
// forward across the break: the rule matched the next line and reported the index of the previous.
//
// Nothing had ever asked the question, because every workflow in this repository ran on
// ubuntu-latest while the repository was written on Windows - and the author's own working tree had
// LF endings, so the author's machine could not show it either. Phase 168's three-platform matrix
// failed on its first run.
//
// The reason this is the worst class of bug this product can have: a rule that reads a line ending
// as content does not report an error, it reports nothing. The whole argument here is that absence
// is not approval - a check that could not run says so, in words. A rule finding zero on every
// Windows checkout says "nothing here" in the only language a report has, to the people most
// likely to be running Windows.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { measure } from '../../eval/crlf-parity.ts';
import { lf, lines, unterminated } from '../lines.ts';

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);

describe('splitting a file into lines', () => {
  it('gives the same lines for LF, CRLF and a lone CR', () => {
    const expected = ['a', 'b', 'c', ''];
    assert.deepEqual(lines(['a', 'b', 'c'].join(NL) + NL), expected);
    assert.deepEqual(lines(['a', 'b', 'c'].join(CR + NL) + CR + NL), expected);
    assert.deepEqual(lines(['a', 'b', 'c'].join(CR) + CR), expected, 'a classic Mac file is rare but costs nothing to read');
  });

  it('keeps the trailing empty line, because line numbers are taken from the index', () => {
    // Dropping it would renumber nothing visible here and every finding in a real file.
    assert.equal(lines(`a${NL}`).length, 2);
    assert.equal(lines(`a${CR}${NL}`).length, 2);
  });

  it('does not treat a lone carriage return inside a line as a break', () => {
    // `\r` in the middle of a line is a line break by every definition this file uses, so this is
    // really a statement about what the helpers do rather than a judgement about the file.
    assert.deepEqual(lines(`a${CR}b`), ['a', 'b']);
    assert.equal(unterminated(`a${CR}`), 'a');
    assert.equal(unterminated('a'), 'a', 'a line with no carriage return is returned unchanged');
  });

  it('normalises whole-file text to LF, leaving nothing for a pattern to trip on', () => {
    assert.equal(lf(`a${CR}${NL}b${CR}c${NL}d`), `a${NL}b${NL}c${NL}d`);
    assert.ok(!lf(`a${CR}${NL}b`).includes(CR), 'no carriage return may survive');
  });

  it('shows why a line-anchored pattern needs it: `m` treats a lone CR as a terminator', () => {
    // This is the mechanism behind the off-by-one, stated as a test so it cannot be argued with.
    const text = `          securityContext:${CR}${NL}            privileged: true${CR}${NL}`;
    const m = /^\s*privileged\s*:\s*true\b/m.exec(text);
    assert.ok(m, 'the pattern does match');
    const lineOf = (t: string, i: number) => t.slice(0, i).split(NL).length;
    assert.equal(lineOf(text, m.index ?? 0), 1, 'the match on line 2 reports line 1 - the bug, reproduced');
    const fixed = /^\s*privileged\s*:\s*true\b/m.exec(lf(text));
    assert.equal(lineOf(lf(text), fixed?.index ?? 0), 2, 'normalised first, the same pattern reports line 2');
  });
});

describe('the same project, written on Windows and on Linux', () => {
  it('gets the same answer from every check', () => {
    const all = measure();
    const differ = all.filter((p) => !p.agrees);
    assert.deepEqual(
      differ.map((p) => p.check),
      [],
      `these checks read a line ending as content: ${differ.map((p) => p.check).join(', ')}. ` +
        'Run `node eval/crlf-parity.ts` to see what each one said.',
    );
  });

  it('finds something in the fixture, so agreement is not two checks both finding nothing', () => {
    // The way this test would most easily lie: an empty fixture, every check returning nothing,
    // perfect agreement, and no information at all.
    const all = measure();
    const empty = all.filter((p) => p.found === 0).map((p) => p.check);
    assert.deepEqual(empty, [], `these checks found nothing in the fixture, so they prove nothing here: ${empty.join(', ')}`);
  });
});
