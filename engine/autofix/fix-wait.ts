// Phase 8, ACT + VERIFY for a race: replace a fixed wait with a condition, then prove it.
//
// The safety rule that makes this different from a locator fix: a wrong locator fails every time,
// so one passing run proves the fix. A flaky test passes by luck, so one passing run proves nothing.
// A wait fix is accepted only after several passes in a row, and it is refused outright unless the
// test asserts something afterwards. Same sandbox as the locator fix: test files only, never
// application code, and the file is restored whenever a candidate is not accepted.
import { relative, resolve, sep } from 'node:path';
import type { PlannedAction } from '../decide.ts';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { AutofixDeps } from './autofix.ts';
import { failingLine, hasAssertionAfter } from './locate.ts';
import { applyWaitFix, findFixedWaits, waitFixCandidates, waitNearest, type WaitSite } from './waits.ts';

/** Passes in a row before a race is called fixed. One pass says nothing about a race. */
export const REQUIRED_PASSES = 3;

export type WaitFixStatus = 'fixed' | 'not-eligible' | 'outside-sandbox' | 'no-fixed-wait' | 'no-assertion' | 'no-candidate' | 'all-candidates-failed';

export interface WaitFixResult {
  testId: string;
  specFile: string;
  status: WaitFixStatus;
  applied: boolean;
  /** The line removed or replaced, and what replaced it. */
  removed?: string;
  replacement?: string;
  why?: string;
  line?: number;
  attempts: Array<{ candidate: string; passes: number; detail: string }>;
  log: string[];
}

export interface WaitFixInput {
  record: TriageRecord;
  diagnosis: Diagnosis;
  action: PlannedAction;
  specFile: string;
  /** Which framework's auto-waiting applies; anything else only gets an explicit wait. */
  framework?: 'playwright' | 'cypress' | 'other';
}

/**
 * Tries to replace the fixed wait nearest the failure, keeping a change only when the test passes
 * REQUIRED_PASSES times in a row. `keep: false` checks the suggestion and restores the file.
 */
export async function attemptWaitFix(
  { record, diagnosis, action, specFile, framework = 'playwright' }: WaitFixInput,
  deps: AutofixDeps,
  { keep = true, passes = REQUIRED_PASSES }: { keep?: boolean; passes?: number } = {},
): Promise<WaitFixResult> {
  const title = record.testId.split(' > ').at(-1) ?? record.testId;
  const result: WaitFixResult = { testId: record.testId, specFile, status: 'not-eligible', applied: false, attempts: [], log: [] };
  const stop = (status: WaitFixStatus, why: string): WaitFixResult => ({ ...result, status, log: [...result.log, why] });

  if (action.kind !== 'fix-wait' || (keep && !action.autonomous)) {
    return stop('not-eligible', `not an agent-eligible wait fix (${diagnosis.category} at ${diagnosis.confidence.toFixed(2)}, action ${action.kind})`);
  }
  const rel = relative(resolve(deps.allowedRoot), resolve(specFile));
  if (rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return stop('outside-sandbox', `refused: ${specFile} is outside the sandbox ${deps.allowedRoot}`);

  const source = deps.readFile(specFile);
  const site: WaitSite | undefined = waitNearest(findFixedWaits(source), failingLine(record.errorStack, specFile));
  if (!site) return stop('no-fixed-wait', `no fixed wait in ${specFile} to replace`);
  result.line = site.line;
  result.removed = site.text;
  result.log.push(`found ${site.text} at line ${site.line}`);

  if (!hasAssertionAfter(source, site.line)) return stop('no-assertion', 'refused: nothing is asserted after the wait, so passing runs would not prove the fix');

  const candidates = waitFixCandidates(source, site, framework);
  if (candidates.length === 0) return stop('no-candidate', 'nothing to replace the wait with: the next step does not act on an element');

  for (const c of candidates) {
    deps.writeFile(specFile, applyWaitFix(source, site, c.replacement));
    const shown = c.replacement === '' ? 'removing the wait' : c.replacement.trim();
    let passed = 0;
    let detail = '';
    for (let i = 0; i < passes; i++) {
      const outcome = await deps.verify(specFile, title);
      detail = outcome.detail;
      if (!outcome.passed) break;
      passed++;
    }
    result.attempts.push({ candidate: shown, passes: passed, detail });
    result.log.push(`tried ${shown}: passed ${passed} of ${passes} run(s)${passed === passes ? '' : ` (${detail})`}`);
    if (passed === passes) {
      if (!keep) deps.writeFile(specFile, source);
      return { ...result, status: 'fixed', applied: keep, replacement: c.replacement, why: c.why, log: keep ? result.log : [...result.log, 'suggestion check only: file restored'] };
    }
    deps.writeFile(specFile, source);
  }
  return stop('all-candidates-failed', `no candidate passed ${passes} runs in a row; original file restored`);
}

/** Diff-style summary of an accepted wait fix, for a pull request. */
export function waitFixDiff(fix: WaitFixResult, displayPath: string): string {
  if (!fix.applied || !fix.removed) return '';
  const added = fix.replacement ? [`+${fix.replacement}`] : [];
  return [`--- a/${displayPath}`, `+++ b/${displayPath}`, `@@ line ${fix.line} @@`, `-${fix.removed}`, ...added].join('\n');
}
