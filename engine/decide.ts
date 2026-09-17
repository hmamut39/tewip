// DECIDE step of the agent loop: turns a diagnosis into the action the agent takes, following
// the autonomy table in ROADMAP.md. Phase 4 renders these actions in every view; executing
// them (fix PRs, re-runs, filing issues) comes with the auto-fix loop in Phase 5.
import type { Diagnosis } from '../reporters/types.ts';

/** Above this, code fixes (locator / wait) may be applied by the agent itself. */
export const AUTO_FIX_ABOVE = 0.85;
/** Below this, the diagnosis is too weak to act on: a human takes over. */
export const ESCALATE_BELOW = 0.5;

export type ActionKind = 'fix-locator' | 'fix-wait' | 'stabilize-test' | 'rerun-and-notify' | 'fix-precondition' | 'file-bug' | 'escalate';
export type Owner = 'developer' | 'sdet' | 'devops';

export interface PlannedAction {
  kind: ActionKind;
  owner: Owner;
  /** True when the autonomy table lets the agent do this without a human (once built). */
  autonomous: boolean;
  /** One imperative sentence: what happens next. */
  summary: string;
  /** Why this action: category, confidence and the threshold that applied. */
  reason: string;
}

/** Facts from the failure that make an action concrete. All optional. */
export interface ActionHints {
  locator?: string;
  /** e.g. getByRole('button', { name: 'Reset' }) from the LOCATOR_DRIFT candidate. */
  suggestedLocator?: string;
  hardWait?: string;
  /** How many elements the locator matched in a strict-mode violation, when that was the error. */
  strictMatches?: number;
  component?: string;
  commit?: string;
  tracePath?: string;
}

const pct = (n: number) => n.toFixed(2);

/**
 * VERIFY -> DECIDE: what re-running the test with the suggested locator says about a drift
 * diagnosis. Passing confirms the suggestion; failing with every candidate means the element was
 * probably not renamed, so a human should check whether the feature itself broke.
 */
export function reviseAfterVerification(action: PlannedAction, outcome: { status: string; replacement?: string }): { action: PlannedAction; note: string | null } {
  if (action.kind !== 'fix-locator') return { action, note: null };
  if (outcome.status === 'fixed' && outcome.replacement) {
    return {
      action: { ...action, summary: `Verified by re-running the test: with ${outcome.replacement} it passes. ${action.summary}`, reason: `${action.reason}; suggestion verified by a re-run` },
      note: `re-running the test with ${outcome.replacement} passed`,
    };
  }
  if (outcome.status === 'all-candidates-failed') {
    return {
      action: {
        kind: 'escalate',
        owner: 'sdet',
        autonomous: false,
        summary: 'The test still fails with the most similar elements on the page, so this is probably not a renamed element: check whether the feature itself still works (possible real bug) before touching the test.',
        reason: `${action.reason}; every suggested locator failed a re-run`,
      },
      note: 'every suggested replacement locator failed when the test was re-run',
    };
  }
  if (outcome.status === 'no-assertion') {
    return {
      action: { ...action, summary: `${action.summary} Cannot be verified automatically: the test has no assertion after this step, so check by hand that the new element is the intended one.` },
      note: 'the suggestion cannot be verified: the test has no assertion after the failing step',
    };
  }
  return { action, note: null };
}

export function decide(d: Diagnosis, hints: ActionHints = {}): PlannedAction {
  const conf = `${d.category} at confidence ${pct(d.confidence)}`;
  const target = hints.locator ? ` ${hints.locator}` : '';

  if (d.category === 'UNKNOWN' || d.confidence < ESCALATE_BELOW) {
    return {
      kind: 'escalate',
      owner: 'sdet',
      autonomous: false,
      summary: 'Needs a human decision: the agent could not classify this confidently. Start from the evidence below.',
      reason: d.category === 'UNKNOWN' ? 'no rule or model decided' : `${conf} is below ${ESCALATE_BELOW}`,
    };
  }

  switch (d.category) {
    case 'ENV':
      return {
        kind: 'rerun-and-notify',
        owner: 'devops',
        autonomous: true,
        summary: 'Do not touch the test. Re-run it once; if it fails again, check the failing dependency named in the evidence and send one grouped notice.',
        reason: `${conf}: environment problems are re-run and reported, never fixed in test code`,
      };
    case 'REAL_BUG':
      return {
        kind: 'file-bug',
        owner: 'developer',
        autonomous: true,
        summary: `File a bug${hints.component ? ` against ${hints.component}` : ''}${hints.commit ? ` for commit ${hints.commit.slice(0, 8)}` : ''} with the trace${hints.tracePath ? ` (${hints.tracePath})` : ''} attached; do not change the test.`,
        reason: `${conf}: the application is broken, so the test stays as it is`,
      };
    case 'LOCATOR_DRIFT': {
      // On real CI data the AI alone called real bugs "drift" at 0.88-0.96, while every correct
      // lab fix came from the deterministic rule that found the renamed element on the page.
      // So code changes need that rule's match, not just a high confidence.
      const matched = d.source === 'rules' && (d.ruleId === 'locator-drift' || d.ruleId === 'locator-drift-strict');
      const auto = d.confidence > AUTO_FIX_ABOVE && matched;
      // A locator that now matches several elements needs narrowing, not renaming.
      const fix = hints.strictMatches && hints.suggestedLocator
        ? `Change the locator${target} to ${hints.suggestedLocator}: it now matches ${hints.strictMatches} elements, and this is the one the test means`
        : hints.strictMatches
        ? `Make the locator${target} more specific: it now matches ${hints.strictMatches} elements (add the element's name, a parent, or exact: true)`
        : hints.suggestedLocator
          ? `Update the locator${target} to ${hints.suggestedLocator}`
          : `Update the locator${target} to match the renamed element`;
      return {
        kind: 'fix-locator',
        owner: 'sdet',
        autonomous: auto,
        summary: `${fix}, re-run the test, and open a PR only if it passes.`,
        reason: auto
          ? `${conf} is above ${AUTO_FIX_ABOVE} and the page has a matching renamed element: auto-fix eligible`
          : !matched
            ? `${conf}, but no deterministic match of a renamed element on the page: an SDET reviews the fix`
            : `${conf} is below ${AUTO_FIX_ABOVE}: an SDET reviews the fix`,
      };
    }
    case 'TIMING': {
      const auto = d.confidence > AUTO_FIX_ABOVE && Boolean(hints.hardWait);
      return hints.hardWait
        ? {
            kind: 'fix-wait',
            owner: 'sdet',
            autonomous: auto,
            summary: `Replace the fixed wait (${hints.hardWait}) with a web-first assertion on the element it waits for, re-run, and open a PR only if it passes.`,
            reason: auto ? `${conf} is above ${AUTO_FIX_ABOVE}: auto-fix eligible (Phase 5)` : `${conf}: an SDET reviews the fix`,
          }
        : {
            kind: 'stabilize-test',
            owner: 'sdet',
            autonomous: false,
            summary: `Make the step${target} wait for the element's ready state (e.g. await expect(locator).toBeVisible()) before acting; quarantine the test if it keeps flaking.`,
            reason: `${conf}: race without a hard-coded wait to replace, so there is no safe automatic fix`,
          };
    }
    case 'TEST_DATA':
      return {
        kind: 'fix-precondition',
        owner: 'sdet',
        autonomous: false,
        summary: 'Fix the test setup: create or reset the data the test assumes (see evidence) before it runs; do not change the assertion.',
        reason: `${conf}: the product is fine, the test's starting data is wrong`,
      };
  }
}
