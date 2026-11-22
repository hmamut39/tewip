// Which tests reach a changed file, and how strongly - the one question, with its answer kept
// honest about which of three kinds of evidence it is.
//
// Split out of prove.ts in Phase 217, when distinguishing the kinds took that file past this
// project's 300-line rule. prove.ts runs mutants; this only reads what already covers what.
import { join, relative } from 'node:path';

/**
 * Which of the tests that cover a file really import it, and so could notice a change - with how
 * each one knows it, which is not one thing.
 *
 * `imports` means the test names this file. `package` means it imports the front door of the
 * folder the file sits in: real evidence, and weaker evidence. Both were returned here as one list
 * and printed as "imports it". On angular-components all eight tests named for
 * `datepicker-input-base.ts` were `package` matches - they import `@angular/material/datepicker`,
 * and not one of them contains the string `datepicker-input-base`. Phase 216 split "imports it"
 * from "reaches it through N import(s)" precisely so a reader could tell strong evidence from
 * weak; this flattened the same distinction one layer up. Phase 217.
 */
export function importingTestsWithHow(
  root: string,
  coverage: Array<{ testFile: string; covers: string[]; how: string }>,
  file: string,
): Array<{ testFile: string; how: string }> {
  const wanted = file.split('\\').join('/');
  return coverage
    .filter((c) => c.how !== 'name' && c.covers.some((covered) => covered.split('\\').join('/') === wanted))
    .map((c) => ({ testFile: relative(root, join(root, c.testFile)).split('\\').join('/'), how: c.how }));
}

/** The same tests, for the callers that only need to run them. */
export const importingTests = (root: string, coverage: Array<{ testFile: string; covers: string[]; how: string }>, file: string): string[] =>
  importingTestsWithHow(root, coverage, file).map((c) => c.testFile);
