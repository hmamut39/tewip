// Phase 21: carrying out the action, not just naming it.
//
// This is the first place Tewip does something because it decided to rather than because a person
// typed it, so the design is mostly refusals.
//
// 1. It never does the work itself. Every action it may take is an existing command that already
//    proves what it changes - `write` keeps a test only if it passes and fails when broken, the
//    wait fix keeps a change only after three passes in a row. Nothing new is trusted here; the
//    gates that were measured stay in the path.
// 2. Only an allowlist may run. An action that is not on it is refused by name, so adding autonomy
//    later is a deliberate edit rather than an emergent behaviour.
// 3. One action, then stop. There is no loop that keeps going until it decides to stop, because
//    nothing here needs one and an agent that cannot be interrupted is not autonomy.
// 4. Everything is written down. What it did, why, and what came of it goes in an audit file the
//    team owns, so "the agent changed something" is never a mystery.
// 5. It will not repeat itself. The same action on the same target is refused until something new
//    has happened, which is what stops a scheduled run grinding at an impossible task.
import type { Act, Decision } from './policy.ts';

export interface Plan {
  /** The verb and arguments to run, as a person could type them. */
  command: string[];
  /** What this action is about, so the same one is not attempted twice over nothing. */
  target: string;
}

/**
 * What Tewip may carry out, and with what. Anything absent is refused: reporting a real bug, for
 * instance, is deliberately not an action - it is for a person to read.
 */
export function planFor(decision: Decision): Plan | null {
  switch (decision.act) {
    case 'cover-gap': {
      // `write` drafts the test, runs it, breaks it on purpose to see it fail, and keeps it only
      // if both hold. The scenario id is in the decision's own next step.
      const id = /write a test for ([\w-]+)/.exec(decision.next)?.[1];
      return id ? { command: ['write', '--only', id], target: `scenario ${id}` } : null;
    }
    case 'attest':
      return { command: ['attest'], target: 'the evidence bundle' };
    default:
      return null;
  }
}

/** Why an action was not carried out, in words a person can act on. */
export const cannotAct: Record<Act, string> = {
  'look-first': 'there is nothing to act on until a report has been read',
  'triage-real-bug': 'a real bug is for a person to see, and Tewip will not work around one on its own',
  'rerun-environment': 'a re-run belongs to whatever runs the tests, not to Tewip',
  'settle-flaky': 'settling a flaky test changes a test file, which Tewip does only when asked directly with `tewip fix`',
  'triage-undecided': 'Tewip cannot say why these failed, so it has nothing it could safely do about them',
  'cover-gap': '',
  attest: '',
  'stand-down': 'there is nothing here that matches the goal',
};

export interface ActionRecord {
  at: string;
  goal: string;
  act: Act;
  target: string;
  command: string;
  /** The run the decision was based on, so the same attempt is not made twice over one report. */
  runId: string;
  /** 'done' | 'refused' | 'failed', and what came of it. */
  outcome: 'done' | 'refused' | 'failed';
  detail: string;
}

/**
 * Has this exact action already been tried against this exact evidence? A scheduled run that keeps
 * attempting an impossible task is the failure mode that makes people turn an agent off. A new run
 * is new evidence and unblocks it; running again over the same report does not.
 *
 * Refusals are not counted: refusing costs nothing and says nothing about whether it would work.
 */
export function alreadyTried(records: ActionRecord[], act: Act, target: string, runId: string): ActionRecord | null {
  return records.find((r) => r.act === act && r.target === target && r.runId === runId && r.outcome !== 'refused') ?? null;
}
