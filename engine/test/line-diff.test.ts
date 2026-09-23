// The diff a reviewer reads and the number the size rule uses come from the same place. These tests
// pin the two mistakes that a real measurement exposed: a two-line fix in two distant places being
// called a fifty-line rewrite, and a moved block being printed as ninety lines of patch.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countChanged, lineDiff, renderDiff } from '../autofix/line-diff.ts';
import { changedLines, changeDiff, MAX_CHANGED_LINES } from '../autofix/code-fix.ts';

const NL = String.fromCharCode(10);
const file = (...lines: string[]) => lines.join(NL);

describe('measuring how big a change is', () => {
  it('counts nothing when nothing changed', () => {
    assert.equal(changedLines(file('a', 'b', 'c'), file('a', 'b', 'c')), 0);
    assert.equal(changeDiff('src/x.ts', file('a', 'b'), file('a', 'b')), '');
  });

  it('counts two lines when two lines changed, however far apart they are', () => {
    const before = file('one', ...Array.from({ length: 50 }, (_, i) => `line ${i}`), 'two');
    const after = before.replace('one', 'ONE').replace('two', 'TWO');
    assert.equal(changedLines(before, after), 4, 'two lines replaced is two removed and two added');
    assert.ok(changedLines(before, after) <= MAX_CHANGED_LINES, 'a small fix in two places is not a rewrite');
  });

  it('still calls a rewrite a rewrite', () => {
    const before = file(...Array.from({ length: 40 }, (_, i) => `old ${i}`));
    const after = file(...Array.from({ length: 40 }, (_, i) => `new ${i}`));
    assert.ok(changedLines(before, after) > MAX_CHANGED_LINES);
  });

  it('prints only the parts that changed, with context around each', () => {
    const before = file(...Array.from({ length: 60 }, (_, i) => `line ${i}`));
    const after = before.replace('line 5', 'line five').replace('line 50', 'line fifty');
    const patch = changeDiff('src/x.ts', before, after);
    assert.match(patch, /^--- a\/src\/x\.ts/);
    assert.equal((patch.match(/^@@/gm) ?? []).length, 2, 'two separate changes are two hunks');
    assert.ok(patch.split(NL).length < 24, `the patch stays small: ${patch.split(NL).length} lines`);
    assert.match(patch, /-line 5$/m);
    assert.match(patch, /\+line five$/m);
  });

  it('shows an inserted block as an insertion, not as a rewrite of everything after it', () => {
    const before = file('function f() {', '  const a = 1;', '  return a;', '}');
    const after = file('function f() {', '  if (!a) return 0;', '  const a = 1;', '  return a;', '}');
    const ops = lineDiff(before, after);
    assert.equal(countChanged(ops), 1, 'one line was added and nothing else moved');
    assert.match(renderDiff('src/x.ts', ops), /\+\s+if \(!a\) return 0;/);
  });
});
