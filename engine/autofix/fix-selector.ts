// ACT + VERIFY for a drifted selector in a Cypress, Selenium or WebdriverIO test.
//
// The same loop as every other fix Tewip makes: change one thing in the test file, run that test,
// keep the change only if it passes, and otherwise put the file back exactly as it was. What is new
// is where the replacement comes from - the repository, not a page snapshot - which is why these
// tools can be fixed at all without a trace.
//
// It will not touch application code, will not change what the test asserts, and will not offer a
// replacement it cannot point at in the source or in a commit.
import { relative, resolve, sep } from 'node:path';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { PlannedAction } from '../decide.ts';
import { driverLocator } from '../driver-errors.ts';
import { likeItInSource, renamedInGit, tokenOf, writeSelector, type Renamed } from './selector-source.ts';

/**
 * Where a selector is written in a test: the whole line, so the replacement reads in context.
 * Cypress and Selenium put the selector in a plain string, so this is simpler than Playwright's
 * chained calls - and looking for the quoted form keeps it from matching a comment about it.
 */
export function findSelectorSites(source: string, selector: string): Array<{ line: number; text: string }> {
  const quoted = [`'${selector}'`, `"${selector}"`, `\`${selector}\``];
  const sites: Array<{ line: number; text: string }> = [];
  source.split('\n').forEach((text, index) => {
    if (quoted.some((q) => text.includes(q))) sites.push({ line: index + 1, text });
  });
  return sites;
}

export type SelectorFixStatus =
  | 'fixed'
  | 'not-eligible'
  | 'outside-sandbox'
  | 'no-selector'
  | 'not-identifiable'
  | 'no-replacement'
  | 'selector-not-in-test'
  | 'still-failing';

export interface SelectorFixResult {
  testId: string;
  specFile: string;
  status: SelectorFixStatus;
  applied: boolean;
  original?: string;
  replacement?: string;
  /** Where the replacement came from, in words a reviewer can check. */
  evidence?: string;
  line?: number;
  log: string[];
}

export interface SelectorFixDeps {
  /** Only files under this directory may be changed: test files, never application code. */
  allowedRoot: string;
  /** The project, for reading the application source and its history. */
  projectRoot: string;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  /** Application source files, for the weaker "it looks like this now" evidence. */
  sources: string[];
  /** Re-runs the one test; true only when it ran and passed. */
  verify(specFile: string, testTitle: string): Promise<{ passed: boolean; detail: string }>;
}

export interface SelectorFixInput {
  record: TriageRecord;
  diagnosis: Diagnosis;
  action: PlannedAction;
  specFile: string;
}

/**
 * One drifted selector, fixed from what the repository knows. `keep` false checks a suggestion
 * without leaving it in the file, exactly as the locator fix does.
 */
export async function attemptSelectorFix(
  { record, diagnosis, action, specFile }: SelectorFixInput,
  deps: SelectorFixDeps,
  { keep = true }: { keep?: boolean } = {},
): Promise<SelectorFixResult> {
  const title = record.testId.split(' > ').at(-1) ?? record.testId;
  const result: SelectorFixResult = { testId: record.testId, specFile, status: 'not-eligible', applied: false, log: [] };
  const stop = (status: SelectorFixStatus, why: string): SelectorFixResult => ({ ...result, status, log: [...result.log, why] });

  if (diagnosis.category !== 'LOCATOR_DRIFT' || action.kind !== 'fix-locator') {
    return stop('not-eligible', `only a renamed element is fixed this way; this one is ${diagnosis.category} (${action.kind})`);
  }
  const rel = relative(resolve(deps.allowedRoot), resolve(specFile));
  if (rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return stop('outside-sandbox', `refused: ${specFile} is outside ${deps.allowedRoot}`);

  // What the tool said it was looking for.
  const selector = driverLocator(record.errorMessage) ?? '';
  if (!selector) return stop('no-selector', 'the error does not say which selector was not found');
  result.log.push(`the test looked for ${selector}`);

  // What the line in the test really holds: Selenium prints "css selector=#x" but writes "#x".
  const written = /^[a-z ]+=\s*/i.test(selector) ? selector.replace(/^[a-z ]+=\s*/i, '') : selector;
  const token = tokenOf(selector);
  if (!token) {
    return stop('not-identifiable', `${selector} is not an id, class or data attribute, so there is nothing in the source to compare it against. A person should look at the page.`);
  }

  // Git first: somebody renamed it, and the commit says to what. The source is the weaker answer.
  const found: Renamed | null = renamedInGit(deps.projectRoot, token) ?? likeItInSource(deps.projectRoot, token, deps.sources);
  if (!found) {
    return stop('no-replacement', `nothing in the source or in the history looks like "${token.value}" renamed. Tewip will not invent a selector.`);
  }
  const evidence =
    found.how === 'renamed in git'
      ? `commit ${found.commit} changed "${token.value}" to "${found.value}" in ${found.file}`
      : `"${token.value}" is nowhere in the source any more, and ${found.file} now has "${found.value}"`;
  result.evidence = evidence;
  result.log.push(evidence);

  const replacement = writeSelector(token, found.value);
  const source = deps.readFile(specFile);
  const sites = findSelectorSites(source, written);
  const site = sites[0];
  if (!site) return stop('selector-not-in-test', `${selector} is not written in ${rel}: it comes from a helper or a page object, which a person should change`);
  result.line = site.line;
  result.original = site.text;
  result.replacement = site.text.replace(written, replacement);

  deps.writeFile(specFile, source.replace(site.text, result.replacement));
  try {
    const run = await deps.verify(specFile, title);
    if (!run.passed) {
      deps.writeFile(specFile, source);
      return stop('still-failing', `with ${replacement} the test still failed, so the file was put back: ${run.detail.slice(-200)}`);
    }
    result.log.push(`with ${replacement} the test passes`);
    if (!keep) deps.writeFile(specFile, source);
    return { ...result, status: 'fixed', applied: keep };
  } catch (error) {
    deps.writeFile(specFile, source);
    throw error;
  }
}

/** The one-line diff a reviewer reads. */
export function selectorFixDiff(result: SelectorFixResult): string {
  if (!result.original || !result.replacement) return '';
  return [`--- a/${result.specFile}`, `+++ b/${result.specFile}`, `@@ line ${result.line} @@`, `-${result.original.trim()}`, `+${result.replacement.trim()}`].join('\n');
}
