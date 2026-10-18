// Does a test report hold the run it says it holds?
//
// Kept apart from the importers because it asks nothing about any one format's shape: it compares a
// report's own declared totals with what is actually inside it, which is the one check that catches
// a file that parsed cleanly and is missing most of its contents.
import { descendants, type XmlElement } from './xml.ts';

/** A failing outcome, under either of the two names JUnit uses for one. */
const FAILURE = new Set(['failure', 'error']);

/**
 * What the report says about itself, against what it actually contains.
 *
 * Every JUnit suite declares its own totals - `tests`, `failures`, `errors` - in the attributes of
 * the element that holds the results. Nothing here ever read them, and a truncated upload is the
 * commonest corruption there is: the runner dies, or the artifact is cut off mid-write, and what
 * arrives is well-formed enough to parse and missing most of the run.
 *
 * Found by handing `tewip explain` a report whose header said `tests="500" failures="37"` and whose
 * body held one passing testcase. The answer was **"All 1 test(s) passed. Nothing to explain."** The
 * evidence that it was reading a fragment was in the file, two lines above the fragment.
 *
 * Only a shortfall is reported. A surplus is ordinary: rerun plugins write an entry per attempt
 * while `tests` counts the test once, so finding more testcases than declared means a re-run, not a
 * corrupt file.
 */
export function shortfall(root: XmlElement): string | null {
  // The one signal that does not depend on the report declaring anything. A streaming writer like
  // node:test puts each suite's totals in its closing tag, so a report cut off in the middle loses
  // the tests and the count of them together and has nothing left to disagree with itself about.
  // What it cannot hide is the tag it never closed.
  if (root.truncated) {
    return 'the file ends in the middle of itself - an element is left open, so it was cut off while being written or uploaded. Whatever ran after that point is not in here, and Tewip cannot say how much that was.';
  }
  const num = (e: XmlElement, key: string) => {
    const n = Number(e.attrs[key]);
    return Number.isFinite(n) ? n : 0;
  };
  // Only the innermost suites are counted. PHPUnit wraps every suite in another suite carrying the
  // same totals, and real PHPUnit output was read as half missing when both levels were added up -
  // a false alarm on a perfectly good report, which is worse than the silence this replaces. A
  // parent's totals already include its children's, so the leaves are the whole run exactly once.
  const all = [...(root.name === 'testsuite' ? [root] : []), ...descendants(root, 'testsuite')];
  const suites = all.filter((e) => descendants(e, 'testsuite').length === 0);
  const totals = (key: string, fallback: string[]) =>
    root.attrs[key] !== undefined
      ? num(root, key)
      : suites.reduce((sum, e) => sum + fallback.reduce((s, k) => s + num(e, k), 0), 0);
  const declaredTests = totals('tests', ['tests']);
  const declaredBad =
    root.attrs.failures !== undefined || root.attrs.errors !== undefined
      ? num(root, 'failures') + num(root, 'errors')
      : suites.reduce((sum, e) => sum + num(e, 'failures') + num(e, 'errors'), 0);

  const cases = descendants(root, 'testcase');
  const foundBad = cases.filter((c) => c.children.some((ch) => FAILURE.has(ch.name))).length;
  const missingTests = declaredTests - cases.length;
  const missingBad = declaredBad - foundBad;
  if (missingTests <= 0 && missingBad <= 0) return null;

  const said: string[] = [];
  if (missingTests > 0) said.push(`${missingTests} of the ${declaredTests} test(s) it says it holds are not in it`);
  if (missingBad > 0) said.push(`${missingBad} of the ${declaredBad} failure(s) it reports are not in it`);
  return `${said.join(', and ')}. This report is a fragment of its run - most likely cut off while being written or uploaded. Nothing below covers the missing part.`;
}
