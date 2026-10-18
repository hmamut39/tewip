// What a change does to the checks that were already agreed.
//
// Measuring test plans against 18 real pull requests that later turned out to have broken something
// found one blind spot, and it was the same one everywhere in Tewip: the pull request's own
// description is treated as the specification. In `budget-mvp#16` the author changed how an
// indicator's freshness was judged, changed the existing test to match, and it was reverted a day
// later because the new rule was wrong for a value that legitimately stops changing. Every layer
// agreed with the change, because every layer was reading the change's own account of itself.
//
// A rewritten expectation is the one place where that assumption is checkable. A test someone wrote
// earlier is behaviour the team agreed on; editing its assertion renegotiates that agreement, and
// deleting it withdraws it. Neither is wrong - tests change for good reasons all the time - but
// both deserve to be said out loud in a review, with the old text and the new one side by side, so
// a person decides rather than a description deciding for them.
//
// This reads the diff only. No model, no network, nothing to configure.
import { execFileSync } from 'node:child_process';

export interface ExpectationChange {
  file: string;
  /** What happened to the agreed behaviour. */
  kind: 'rewritten' | 'withdrawn' | 'renamed';
  /** The test whose expectation moved, when the hunk names one. */
  test: string;
  before: string;
  after: string;
}

const IS_TEST_FILE = /(\.spec\.|\.test\.|_test\.|test_|\/tests?\/|\/e2e\/|\/cypress\/|Test\.(java|kt|cs)$|_spec\.rb$)/i;
/** A line that checks something: the sentence of the agreement. */
const ASSERTION = /\b(?:expect|assert|should|verify|assertEquals|assertThat|assertTrue|assertFalse|toBe|toEqual|toMatch|toHaveBeenCalled|require\.\w+|is\.\w+)\b/;
/** A line that names a test: the title people read in a report. */
const TEST_TITLE = /\b(?:it|test|describe|context|scenario|def test_\w+|func Test\w+|@Test)\b\s*[( ]/;

const title = (line: string): string =>
  /['"`]([^'"`]{4,120})['"`]/.exec(line)?.[1] ?? /\b(?:def|func)\s+(\w+)/.exec(line)?.[1] ?? '';

/** The diff of test files only, which is all this looks at. */
function testDiff(root: string, range: string): string {
  try {
    // Captured, not inherited: see the note in grounding.ts.
    return execFileSync('git', ['diff', '--unified=0', range, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

/**
 * Expectations this change rewrites, withdraws or renames. A brand-new test is not reported: adding
 * checks is not renegotiating anything, and a review that cried out about every added test would be
 * ignored within a week.
 */
export function changedExpectations(root: string, range: string, diff = testDiff(root, range)): ExpectationChange[] {
  const out: ExpectationChange[] = [];
  let file = '';
  let isNewFile = false;
  let removed: string[] = [];
  let added: string[] = [];

  const flush = (): void => {
    if (!isNewFile && file) {
      const gone = removed.filter((l) => ASSERTION.test(l));
      const fresh = added.filter((l) => ASSERTION.test(l));
      for (const [i, before] of gone.entries()) {
        const after = fresh[i] ?? '';
        out.push({
          file,
          kind: after ? 'rewritten' : 'withdrawn',
          test: title(removed.find((l) => TEST_TITLE.test(l)) ?? '') || title(added.find((l) => TEST_TITLE.test(l)) ?? ''),
          before: before.trim().slice(0, 160),
          after: after.trim().slice(0, 160),
        });
      }
      const renamedFrom = removed.find((l) => TEST_TITLE.test(l) && title(l));
      const renamedTo = added.find((l) => TEST_TITLE.test(l) && title(l));
      if (renamedFrom && renamedTo && title(renamedFrom) !== title(renamedTo) && gone.length === 0) {
        out.push({ file, kind: 'renamed', test: title(renamedFrom), before: title(renamedFrom), after: title(renamedTo) });
      }
    }
    removed = [];
    added = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      flush();
      file = /b\/(\S+)/.exec(line)?.[1] ?? '';
      isNewFile = false;
      continue;
    }
    // A file added by this change had no agreed behaviour to renegotiate.
    if (line.startsWith('new file mode')) isNewFile = true;
    if (line.startsWith('@@')) flush();
    if (!file || !IS_TEST_FILE.test(file)) continue;
    if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
    else if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  flush();
  return out;
}

/** The sentences a reviewer reads. Never a verdict: this asks, it does not decide. */
export function renderExpectations(changes: ExpectationChange[]): string[] {
  if (changes.length === 0) return [];
  const rewritten = changes.filter((c) => c.kind === 'rewritten');
  const withdrawn = changes.filter((c) => c.kind === 'withdrawn');
  const renamed = changes.filter((c) => c.kind === 'renamed');

  const lines = ['## Checks this change renegotiates', ''];
  lines.push(
    `This change edits ${changes.length} check(s) that were already agreed: ${[
      rewritten.length ? `${rewritten.length} rewritten` : '',
      withdrawn.length ? `${withdrawn.length} withdrawn` : '',
      renamed.length ? `${renamed.length} renamed` : '',
    ]
      .filter(Boolean)
      .join(', ')}. Tests change for good reasons, so this is not a fault - but a test written earlier is behaviour someone agreed on, and the change's own description cannot tell you whether replacing it was intended.`,
    '',
  );
  for (const change of [...withdrawn, ...rewritten, ...renamed].slice(0, 10)) {
    const where = `${change.file.split('/').at(-1)}${change.test ? ` — ${change.test}` : ''}`;
    if (change.kind === 'withdrawn') {
      lines.push(`- **${where}** no longer checks: \`${change.before}\``);
    } else if (change.kind === 'renamed') {
      lines.push(`- **${where}** was renamed to "${change.after}", so a report of it will no longer match the old name`);
    } else {
      lines.push(`- **${where}**`, `  - was: \`${change.before}\``, `  - now: \`${change.after}\``);
    }
  }
  lines.push('', 'Ask the author which of these the change intended, and which followed from it.');
  return lines;
}
