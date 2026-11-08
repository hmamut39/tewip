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

/**
 * `keys` lists the words that count as a configuration key, written out rather than derived from
 * `re` - which was the first attempt, and was worse than the problem it solved.
 *
 * Pulling the words out of the pattern's own source looked like it could not drift. What it did was
 * pull out *fragments*: `tool_allow_?list` yields `list`, so every `'list':` in any object anywhere
 * counted as a tool allow-list. nocodb's icon map and two Saleor migrations came back as gating an
 * agent's tools. A derivation that cannot tell a word from a piece of one is not a safeguard
 * against drift, it is a second thing to get wrong. The test beside this holds every key to its own
 * pattern instead, which is the guarantee the derivation was reaching for.
 */
const PATTERNS: Array<{ kind: GuardKind; re: RegExp; keys: string[] }> = [
  {
    kind: 'asks-a-person',
    // LangGraph's interrupt and interrupt_before, LangChain's human tools, and the plain words
    // people use when they write the gate themselves.
    //
    // The `interrupt` branch is split out of the alternation and carries no trailing `\b`, which it
    // used to inherit from the group. A word boundary after `[(=]` demands that the next character
    // be a *word* character - so `interrupt(state)` matched and `interrupt({"question": ...})` and
    // `interrupt_before=["tools"]` did not, which are the two forms LangGraph's own human-in-the-
    // loop page is written in. Measured at eval/guard-recall.ts, this cost both of them.
    re: /\binterrupt(?:_before|_after)?\s*[(=]|\b(?:human_in_the_loop|humanInTheLoop|interruptBefore|interruptAfter|HumanInputRun|HumanApprovalCallbackHandler|requires?_approval|requiresApproval|needs_approval|needsApproval|human_input|humanInput|await_approval|ask_human|askHuman|confirm_with_user|human_review)\b/g,
    keys: ['interrupt_before', 'interrupt_after', 'interruptBefore', 'interruptAfter', 'human_input', 'humanInput', 'needs_approval', 'needsApproval', 'requires_approval', 'requiresApproval', 'human_in_the_loop', 'humanInTheLoop'],
  },
  {
    kind: 'dry-run',
    re: /\b(?:dry_run|dryRun|DRY_RUN|--dry-run|preview_only|previewOnly|simulate_only|no_execute)\b/g,
    keys: ['dry_run', 'dryRun', 'preview_only', 'previewOnly', 'simulate_only', 'no_execute'],
  },
  {
    kind: 'step-budget',
    // `stopWhen` and `stepCountIs` are how the Vercel AI SDK declares a ceiling since it dropped
    // `maxSteps`, which makes them the current shape for a large share of TypeScript agents.
    re: /\b(?:max_iterations|maxIterations|max_steps|maxSteps|recursion_limit|recursionLimit|max_turns|maxTurns|max_tool_calls|maxToolCalls|max_tool_roundtrips|stop_after_attempt|stopWhen|stepCountIs)\b/g,
    keys: ['max_iterations', 'maxIterations', 'max_steps', 'maxSteps', 'recursion_limit', 'recursionLimit', 'max_turns', 'maxTurns', 'max_tool_calls', 'maxToolCalls', 'max_tool_roundtrips', 'stop_after_attempt'],
  },
  {
    kind: 'tool-allow-list',
    re: /\b(?:allowed_tools|allowedTools|tool_allow_?list|toolAllow_?[Ll]ist|permitted_tools|enabled_tools|ALLOWED_TOOLS)\b/g,
    keys: ['allowed_tools', 'allowedTools', 'tool_allowlist', 'tool_allow_list', 'permitted_tools', 'enabled_tools'],
  },
];

const lineOf = (text: string, index: number): number => text.slice(0, index).split(NL).length;


/**
 * One of these words, written as a quoted key in a configuration object.
 *
 * `graph.invoke(state, config={"recursion_limit": 25})` is how LangGraph's own page sets a ceiling,
 * and this scan reads code with string *contents* blanked - so that key arrived as
 * `{"               ": 25}`, and a ceiling that was declared read as no ceiling at all.
 *
 * Blanking strings is right, and the recall harness has a decoy that shows why: `print("pass
 * --dry-run to see what would happen")` is help text about a flag the code does not implement, and
 * counting it would report a gate in a project that has none. So the shape is what separates the
 * two, not the quoting. `"word":` is a key with a value under it; the same word loose in a sentence
 * inside a string is not, and stays invisible.
 */
const CONFIG_KEY = /["']([\w]+)["']\s*:/g;

/**
 * The option being described rather than set.
 *
 * A project that publishes its own configuration surface writes `max_iterations: { type: "integer",
 * description: "cap the loop" }`, and that is a statement that a ceiling *can* be set, by somebody
 * else, later. Reading it as a ceiling reports a guard in a project that has none - the direction
 * that reads as reassurance, which is the one this check must never get wrong. A budget that is
 * actually set has a number, a boolean or a list under it; a schema has a type under it.
 *
 * Found by a decoy in eval/guard-recall.ts, and it predates the quoted-key rule it was written to
 * test: the plain pattern matched the unquoted key just as readily.
 */
const JUST_DESCRIBED = (text: string, at: number): boolean =>
  /^\s*[:=]\s*\{\s*["']?(?:type|description|default|enum|anyOf|\$ref)\b/.test(text.slice(at));

/** A TypeScript field saying what type the option has, which is not the same as setting it. */
const ONLY_A_TYPE = /^\s*\??\s*:\s*(?:number|string|boolean|bigint)(?:\[\])?\s*(?:\|\s*(?:number|string|boolean|null|undefined)(?:\[\])?\s*)*[;,)}]/;

export function guardsIn(file: string, text: string, blanked?: Blanked): Guard[] {
  const out: Guard[] = [];
  const parts = blanked ?? blank(text, /\.py$/i.test(file));
  const code = parts.calls;
  // Every quoted configuration key in the file, which the blanked text cannot show.
  const keys = new Set([...parts.code.matchAll(CONFIG_KEY)].map((k) => k[1]));
  const keyLine = new Map([...parts.code.matchAll(CONFIG_KEY)].map((k) => [k[1], k.index ?? 0]));
  for (const { kind, re, keys: configKeys } of PATTERNS) {
    // Every place this guard is named in the code, not only the first.
    //
    // Two reasons. The first match can be a schema declaring the option, with the real setting
    // further down the file. And it can be a type annotation - n8n's agent runtime declares
    // `maxIterations: number;` on an interface, which was the evidence line this check offered for
    // "the loop has a declared ceiling". The finding is right, because a field exists only because
    // something uses it, but the evidence was a type rather than a ceiling, and the evidence is the
    // whole reason a reader does not have to take any of this on trust. So a line that sets a value
    // is preferred over one that merely names the field, and the weaker line is still used when it
    // is all there is.
    let m: { 0: string; index: number } | undefined;
    let weaker: { 0: string; index: number } | undefined;
    for (const hit of code.matchAll(re)) {
      const at = hit.index ?? 0;
      if (JUST_DESCRIBED(code, at + hit[0].length)) continue;
      const here = { 0: hit[0], index: at };
      if (ONLY_A_TYPE.test(code.slice(at + hit[0].length))) {
        weaker ??= here;
        continue;
      }
      m = here;
      break;
    }
    m ??= weaker;
    re.lastIndex = 0;
    if (!m) {
      // Nothing in the code, so ask whether the guard was named as a configuration key. The words
      // come from the pattern itself rather than a second list, so the two cannot drift apart;
      // `\b` and the other escapes are stripped first, or `\binterrupt` would be looked for as a
      // key called `binterrupt`.
      for (const word of configKeys) {
        const at = keyLine.get(word);
        if (!keys.has(word) || at === undefined) continue;
        if (JUST_DESCRIBED(parts.code, at + word.length + 2)) continue;
        m = { 0: word, index: at };
        break;
      }
    }
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
