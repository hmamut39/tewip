// What stands between an agent's tools and the real world.
//
// The decision tree every serious write-up of agent safety draws is the same: is the tool on an
// allow-list, is the input clean, is there a budget, is this a dry run, and for anything that pays,
// deletes or sends - ask a human. Each of those is a thing somebody either wrote in this project or
// did not, and a file can be read for it.
//
// What a reader must not take from this: that finding `interrupt()` somewhere means the dangerous
// tools are gated. It means a gate exists in this project. Whether it stands in front of the tool
// that issues refunds is a question about the running graph, and this does not answer it - the
// report says so in those words. The useful half is the other direction: when nothing anywhere in
// a project asks a person anything, and the agent can delete and pay, that is not a maybe.
import { blank, type Blanked } from './source-text.ts';

const NL = String.fromCharCode(10);

export interface Guard {
  kind: GuardKind;
  file: string;
  line: number;
  /** The text that matched, so the claim is checkable. */
  evidence: string;
}

export type GuardKind = 'asks-a-person' | 'dry-run' | 'step-budget' | 'tool-allow-list';

export const GUARD_MEANS: Record<GuardKind, string> = {
  'asks-a-person': 'something here stops and waits for a person',
  'dry-run': 'something here can run without touching anything',
  'step-budget': 'the loop has a declared ceiling, so it cannot run forever',
  'tool-allow-list': 'the tools are drawn from a named list rather than whatever is in scope',
};

/** Why each one matters, in the words of the failure it prevents. */
export const GUARD_PREVENTS: Record<GuardKind, string> = {
  'asks-a-person': 'a refund, a deletion or an email going out because a model decided it should',
  'dry-run': 'having to find out what it would do by letting it do it',
  'step-budget': 'loop divergence - the agent retrying the same failing tool until the bill arrives',
  'tool-allow-list': 'a tool reaching the model because it was in scope, not because anyone chose it',
};

const PATTERNS: Array<{ kind: GuardKind; re: RegExp }> = [
  {
    kind: 'asks-a-person',
    // LangGraph's interrupt and interrupt_before, LangChain's human tools, and the plain words
    // people use when they write the gate themselves.
    re: /\b(?:interrupt(?:_before|_after)?\s*[(=]|human_in_the_loop|humanInTheLoop|HumanInputRun|requires?_approval|requiresApproval|needs_approval|await_approval|ask_human|askHuman|confirm_with_user|human_review)\b/g,
  },
  {
    kind: 'dry-run',
    re: /\b(?:dry_run|dryRun|DRY_RUN|--dry-run|preview_only|previewOnly|simulate_only|no_execute)\b/g,
  },
  {
    kind: 'step-budget',
    re: /\b(?:max_iterations|maxIterations|max_steps|maxSteps|recursion_limit|recursionLimit|max_turns|maxTurns|max_tool_calls|maxToolCalls|max_tool_roundtrips|stop_after_attempt)\b/g,
  },
  {
    kind: 'tool-allow-list',
    re: /\b(?:allowed_tools|allowedTools|tool_allow_?list|toolAllow_?[Ll]ist|permitted_tools|enabled_tools|ALLOWED_TOOLS)\b/g,
  },
];

const lineOf = (text: string, index: number): number => text.slice(0, index).split(NL).length;


export function guardsIn(file: string, text: string, blanked?: Blanked): Guard[] {
  const out: Guard[] = [];
  const code = (blanked ?? blank(text, /\.py$/i.test(file))).calls;
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(code);
    re.lastIndex = 0;
    if (!m) continue;
    const line = lineOf(text, m.index);
    const evidence = (text.split(NL)[line - 1] ?? '').trim().slice(0, 120);
    out.push({ kind, file, line, evidence });
  }
  return out;
}

/**
 * A step budget that is written down but set to nothing.
 *
 * `max_iterations=None` and `recursion_limit = 0` are how a ceiling gets removed without anybody
 * deleting the line, and a check that only looks for the word would call that a budget. Reported
 * apart from "no budget at all" because it is worse: it reads as deliberate.
 */
export function budgetSetToNothing(raw: string): string | null {
  const text = blank(raw, false).calls;
  const m = /\b(?:max_iterations|maxIterations|max_steps|maxSteps|recursion_limit|recursionLimit|max_turns|maxTurns)\s*[:=]\s*(None|null|0|-1|Infinity|float\(["']inf["']\))/.exec(text);
  return m ? m[0].replace(/\s+/g, ' ') : null;
}
