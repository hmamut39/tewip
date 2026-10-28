// Phase 8, ACT + VERIFY for a data collision: make the hand-written value unique per run.
//
// The verification here is the strongest of any fix Tewip makes, and it comes for free: run the
// fixed test TWICE. The first run creates the record; if the value is not really unique, the second
// run collides with what the first one just created and fails. So two passes in a row do not merely
// suggest the fix works - they prove the property the fix is for.
//
// Same sandbox as the other fixes: test files only, never application code, and the file goes back
// exactly as it was unless a candidate is accepted.
import { relative, resolve, sep } from 'node:path';
import type { PlannedAction } from '../decide.ts';
import { chooseDataSite } from './data-site.ts';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { AutofixDeps } from './autofix.ts';
import { applyDataFix, collision, dataFixCandidates, findLiteral, languageOf, type LiteralSite } from './data.ts';

/** Two passes in a row: the second run is what proves the value is really unique. */
export const REQUIRED_PASSES = 2;

export type DataFixStatus = 'fixed' | 'not-eligible' | 'outside-sandbox' | 'no-collision' | 'value-unknown' | 'value-not-in-test' | 'value-only-asserted' | 'value-ambiguous' | 'value-also-asserted' | 'value-also-asserted' | 'no-candidate' | 'all-candidates-failed';

export interface DataFixResult {
  testId: string;
  specFile: string;
  status: DataFixStatus;
  applied: boolean;
  original?: string;
  replacement?: string;
  why?: string;
  line?: number;
  attempts: Array<{ candidate: string; passes: number; detail: string }>;
  log: string[];
}

export interface DataFixInput {
  record: TriageRecord;
  diagnosis: Diagnosis;
  action: PlannedAction;
  specFile: string;
}

export async function attemptDataFix(
  { record, diagnosis, action, specFile }: DataFixInput,
  deps: AutofixDeps,
  { keep = true, passes = REQUIRED_PASSES }: { keep?: boolean; passes?: number } = {},
): Promise<DataFixResult> {
  const title = record.testId.split(' > ').at(-1) ?? record.testId;
  const result: DataFixResult = { testId: record.testId, specFile, status: 'not-eligible', applied: false, attempts: [], log: [] };
  const stop = (status: DataFixStatus, why: string): DataFixResult => ({ ...result, status, log: [...result.log, why] });

  if (action.kind !== 'fix-precondition' || (keep && !action.autonomous)) {
    return stop('not-eligible', `not an agent-eligible data fix (${diagnosis.category} at ${diagnosis.confidence.toFixed(2)}, action ${action.kind})`);
  }
  const rel = relative(resolve(deps.allowedRoot), resolve(specFile));
  if (rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return stop('outside-sandbox', `refused: ${specFile} is outside the sandbox ${deps.allowedRoot}`);

  const found = collision(record.errorMessage);
  if (!found) return stop('no-collision', 'the error does not say that anything already existed');
  if (!found.value) {
    // Postgres often names only the constraint. Changing the test's data on a guess could silently
    // change what the test checks, so this stops and says what a person would need to look at.
    return stop('value-unknown', `${found.where} was violated, but the error does not print the value that already existed, so there is nothing safe to make unique`);
  }
  result.log.push(`the test collided on ${found.where} = "${found.value}"`);

  const source = deps.readFile(specFile);
  const sites: LiteralSite[] = findLiteral(source, found.value);
  if (sites.length === 0) return stop('value-not-in-test', `"${found.value}" is not written in ${specFile}: it comes from a fixture or a factory, which a person should make unique`);
  // Not simply the first occurrence: a colliding value is often also a value the test checks, and
  // rewriting that would change what the test asserts while leaving the collision in place.
  const choice = chooseDataSite(source, sites, found.value);
  if (!choice.site) return stop(choice.reason, `refused: ${choice.why}`);
  const site = choice.site;
  result.log.push(choice.why);
  result.line = site.line;
  result.original = site.text;

  const candidates = dataFixCandidates(found.value, languageOf(specFile));
  if (candidates.length === 0) return stop('no-candidate', `Tewip does not know how to write a unique value in ${specFile}`);

  // The file goes back unless the fix is proved, including when the verifier throws rather than
  // answering - which was the one way out of this loop that did not. See autofix.ts.
  try {
    for (const c of candidates) {
      deps.writeFile(specFile, applyDataFix(source, site, c.expression));
      let passed = 0;
      let detail = '';
      for (let i = 0; i < passes; i++) {
        const outcome = await deps.verify(specFile, title);
        detail = outcome.detail;
        if (!outcome.passed) break;
        passed++;
      }
      result.attempts.push({ candidate: c.expression, passes: passed, detail });
      result.log.push(`tried ${c.expression}: passed ${passed} of ${passes} run(s)${passed === passes ? ', so the value really is different every run' : ` (${detail})`}`);
      if (passed === passes) {
        if (!keep) deps.writeFile(specFile, source);
        return { ...result, status: 'fixed', applied: keep, replacement: c.expression, why: c.why, log: keep ? result.log : [...result.log, 'suggestion check only: file restored'] };
      }
      deps.writeFile(specFile, source);
    }
  } catch (error) {
    deps.writeFile(specFile, source);
    throw error;
  }
  return stop('all-candidates-failed', `no candidate passed ${passes} runs in a row; original file restored`);
}

/** Diff-style summary of an accepted data fix, for a pull request. */
export function dataFixDiff(fix: DataFixResult, displayPath: string): string {
  if (!fix.applied || !fix.original || !fix.replacement) return '';
  return [`--- a/${displayPath}`, `+++ b/${displayPath}`, `@@ line ${fix.line} @@`, `-${fix.original}`, `+${fix.replacement}`].join('\n');
}
