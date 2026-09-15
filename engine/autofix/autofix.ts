// ACT + VERIFY for LOCATOR_DRIFT (ROADMAP Phase 5): rewrite the drifted locator in the test,
// re-run that single test, keep the change only if it passes, otherwise restore the file.
// Safety rules enforced here, not left to callers:
// - only failures the DECIDE step marked as agent-eligible fix-locator actions (> 0.85)
// - only files inside `allowedRoot` (a sandbox copy of the tests), never application code
// - never when the test has no assertion after the rewritten call (a pass would prove nothing)
// - at most MAX_CANDIDATES attempts; every step is logged with its reason
import { relative, resolve, sep } from 'node:path';
import type { PlannedAction } from '../decide.ts';
import { extractLocator } from '../error-parse.ts';
import type { SnapshotElement } from '../snapshot.ts';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import { candidatesFor } from './candidates.ts';
import { failingLine, findLocatorSites, hasAssertionAfter, type LocatorSite } from './locate.ts';

export const MAX_CANDIDATES = 3;

export type FixStatus = 'fixed' | 'not-eligible' | 'outside-sandbox' | 'locator-not-found' | 'no-assertion' | 'no-candidate' | 'all-candidates-failed';

export interface FixResult {
  testId: string;
  specFile: string;
  status: FixStatus;
  original?: string;
  replacement?: string;
  line?: number;
  attempts: Array<{ candidate: string; passed: boolean; detail: string }>;
  /** Every decision the loop made, in order, with the reason (ROADMAP: every action is logged). */
  log: string[];
}

export interface AutofixDeps {
  /** Only files under this directory may be changed. */
  allowedRoot: string;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  /** Re-runs one test; resolves true only if it ran and passed. */
  verify(specFile: string, testTitle: string): Promise<{ passed: boolean; detail: string }>;
  loadSnapshot(record: TriageRecord): SnapshotElement[] | null;
}

export interface FixInput {
  record: TriageRecord;
  diagnosis: Diagnosis;
  action: PlannedAction;
  /** Absolute path of the spec file the record points at. */
  specFile: string;
}

function pickSite(sites: LocatorSite[], line: number | null): LocatorSite | undefined {
  if (sites.length <= 1 || line === null) return sites[0];
  // Prefer the call on the failing line, else the nearest one above it (same test body).
  return sites.find((s) => s.line === line) ?? [...sites].filter((s) => s.line <= line).sort((a, b) => b.line - a.line)[0] ?? sites[0];
}

export async function attemptFix({ record, diagnosis, action, specFile }: FixInput, deps: AutofixDeps): Promise<FixResult> {
  const title = record.testId.split(' > ').at(-1) ?? record.testId;
  const result: FixResult = { testId: record.testId, specFile, status: 'not-eligible', attempts: [], log: [] };
  const stop = (status: FixStatus, why: string) => ({ ...result, status, log: [...result.log, why] });

  if (action.kind !== 'fix-locator' || !action.autonomous) return stop('not-eligible', `not an agent-eligible locator fix (${diagnosis.category} at ${diagnosis.confidence.toFixed(2)}, action ${action.kind})`);
  const rel = relative(resolve(deps.allowedRoot), resolve(specFile));
  if (rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return stop('outside-sandbox', `refused: ${specFile} is outside the sandbox ${deps.allowedRoot}`);

  const locator = extractLocator(record.errorMessage);
  const source = deps.readFile(specFile);
  const site = locator ? pickSite(findLocatorSites(source, locator), failingLine(record.errorStack, specFile)) : undefined;
  if (!locator || !site) return stop('locator-not-found', `could not find the failing locator ${locator ?? '(none in error)'} in ${specFile}`);
  result.original = site.text;
  result.line = site.line;
  result.log.push(`found ${site.text} at line ${site.line}`);

  if (!hasAssertionAfter(source, site.line)) return stop('no-assertion', 'refused: the test has no expect() after this call, so a passing re-run would not prove the fix');

  const snapshot = deps.loadSnapshot(record) ?? [];
  const candidates = candidatesFor(locator, snapshot, MAX_CANDIDATES);
  if (candidates.length === 0) return stop('no-candidate', 'no element on the failure-time page is similar enough to the old locator');

  for (const c of candidates) {
    const patched = source.slice(0, site.start) + c.expression + source.slice(site.end);
    deps.writeFile(specFile, patched);
    const outcome = await deps.verify(specFile, title);
    result.attempts.push({ candidate: c.expression, passed: outcome.passed, detail: outcome.detail });
    result.log.push(`tried ${c.expression} (similarity ${c.score.toFixed(2)}): ${outcome.passed ? 'test passed' : `test still fails (${outcome.detail})`}`);
    if (outcome.passed) return { ...result, status: 'fixed', replacement: c.expression };
    deps.writeFile(specFile, source);
  }
  return stop('all-candidates-failed', `all ${candidates.length} candidate(s) failed verification; original file restored`);
}

/** Unified-diff-style summary of an accepted fix, for a PR description. */
export function fixDiff(fix: FixResult, displayPath: string): string {
  if (fix.status !== 'fixed' || !fix.original || !fix.replacement) return '';
  return [`--- a/${displayPath}`, `+++ b/${displayPath}`, `@@ line ${fix.line} @@`, `-${fix.original}`, `+${fix.replacement}`].join('\n');
}
