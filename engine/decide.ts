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
  component?: string;
  commit?: string;
  tracePath?: string;
}

const pct = (n: number) => n.toFixed(2);

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
      const auto = d.confidence > AUTO_FIX_ABOVE;
      const fix = hints.suggestedLocator ? `Update the locator${target} to ${hints.suggestedLocator}` : `Update the locator${target} to match the renamed element`;
      return {
        kind: 'fix-locator',
        owner: 'sdet',
        autonomous: auto,
        summary: `${fix}, re-run the test, and open a PR only if it passes.`,
        reason: auto ? `${conf} is above ${AUTO_FIX_ABOVE}: auto-fix eligible (auto-fix loop is Phase 5)` : `${conf} is below ${AUTO_FIX_ABOVE}: an SDET reviews the fix`,
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
