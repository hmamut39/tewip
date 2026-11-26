// OWASP ASI09, Human-Agent Trust Exploitation: a gate that cannot say no.
//
// OWASP's own launch post for this list describes ASI09 as confident, polished explanations
// misleading a human operator into approving a harmful action, and the pattern lists name two
// things that live in source rather than in an interface: **approval steps that have quietly
// stopped being checks**, and consent laundered through a preview. This file is the first.
//
// It exists because of a sentence this project prints. `guards.ts` finds the places a project asks
// a person something and the report says:
//
//     - **asks-a-person** - found at app/tools.py:84. something here stops and waits for a person.
//
// That is a reassuring claim, and nothing checked whether the answer is used. A `confirm()` whose
// return value is discarded asks the question, shows it, and carries on either way. The person sees
// a prompt, answers it, watches the action happen, and has been told by the software that they were
// consulted. The strongest form of over-trust OWASP describes is not an agent arguing with somebody
// - it is somebody believing a control exists because they were shown one.
//
// This is the same shape as `budgetSetToNothing` in `guards.ts` - a ceiling written down and set to
// nothing - and the same shape as `vouch`, which finds tests that cannot fail. A gate that cannot
// refuse is a test that cannot fail, pointed at a person.
//
// Three decisions worth stating, because each is the difference between a finding and an
// accusation:
//
//   - **`interrupt()` is not here.** LangGraph's `interrupt` suspends the graph when it is called;
//     nothing continues until somebody resumes it. Its return value is the person's answer, and a
//     project that ignores that answer has still stopped and still required a person to act. The
//     gate refuses by not being resumed. Reporting it would accuse the one framework that makes
//     this correct by construction.
//   - **Only two shapes are reported**, both unambiguous: the answer is thrown away on the spot, or
//     it is put in a name the rest of the function never mentions again. Anything else - read in a
//     condition, handed to a callback, returned to a caller, passed anywhere at all - is left
//     alone. The first draft of this reported 54 gates across the corpus and every one was a
//     correct implementation, which is how the list in `call-shape.ts` was written.
//   - It cannot tell whether the gate stands in front of the dangerous tool. That is the same
//     limitation the guard list already states about itself, and the report states it again.
import { blank, type Blanked } from './source-text.ts';
import { argumentsOf, callFits, expressionStart, isDeclaration, restOfBody, statementStart } from './call-shape.ts';

const NL = String.fromCharCode(10);

export interface ToothlessGate {
  file: string;
  line: number;
  /** The call that asks, quoted from the source. */
  gate: string;
  /** The question itself, where it is written as a literal - which is what the person sees. */
  asked: string | null;
  /** Which of the two shapes this is, in words a reader can check against the line. */
  why: 'its answer is thrown away where it is asked' | 'its answer is put in a name nothing reads again';
  evidence: string;
}

/**
 * A call that asks a person and hands back their answer.
 *
 * Every name here is a question whose result is the whole point of asking. Deliberately not
 * `interrupt`, for the reason in the header; deliberately not `confirmAction`, which names
 * *performing* the action that was confirmed rather than asking - n8n's `confirmAction(requestId,
 * payload)` sends a decision and has no answer to read; and deliberately not the configuration
 * spellings (`interrupt_before=[...]`, `requires_approval: true`), because a gate declared to a
 * framework is enforced by that framework and only a gate a project implements itself can be
 * written without teeth.
 */
const GATES =
  /\b(?:confirm|confirm_with_user|confirmWithUser|ask_human|askHuman|ask_user|askUser|ask_permission|askPermission|prompt_user|promptUser|human_review|humanReview|request_approval|requestApproval|await_approval|awaitApproval|get_approval|getApproval|check_approval|checkApproval|HumanInputRun)\s*\(/g;

/**
 * Python's `input()`, which is how most hand-written gates are actually spelled.
 *
 * `input(` on its own is far too broad - it is a builtin, and `.input(` is a method on half the
 * libraries in the world - so this requires the prompt to read like a question about permission.
 * The prompt is the evidence either way: it is what the person was shown, and quoting it back is
 * what makes the finding checkable rather than a claim about control flow.
 */
// Case-insensitive, which is not decoration. A prompt is a sentence shown to a person, so it
// starts with a capital letter - and written case-sensitively this matched "are you sure" but not
// "Are you sure", so every prompt that reads like English was invisible unless it happened to
// carry a `[y/N]` as well. The injection check learned the same lesson in Phase 217 and has a
// helper for it; one flag does the job here, because these are whole words rather than parts of an
// identifier.
const ASKS_IN_WORDS = /\b(?:are\s+you\s+sure|confirm|proceed|continue\?|approve|overwrite|delete|really)\b|\[?[yY]\s*\/\s*[nN]\]?|\byes\s*\/\s*no\b/i;
const PY_INPUT = /(?<![.\w])input\s*\(/g;

/**
 * The answer was used right here.
 *
 * A gate read in a condition has `if`, `while`, `assert`, `not`, `!` or a boolean operator before
 * it; a gate whose answer is kept has an `=`; a gate handed to something else has a bracket or a
 * comma. A gate with nothing in front of it but whitespace, `await` or the end of the previous
 * statement is a gate whose answer goes nowhere.
 */
const USED_HERE = /(?:\bif|\belif|\bwhile|\bassert|\breturn|\bnot|\band|\bor|\byield|&&|\|\||[!?:,=([<>+-])\s*(?:await\s+|async\s+)*$/;
const ASSIGNED = /(?:(?:const|let|var)\s+)?([\w.#]+)\s*(?::\s*[\w[\]|<> ]+\s*)?=\s*(?:await\s+)?$/;

/**
 * The answer is delivered to a handler instead of being returned.
 *
 * `this.dialog.confirm({ message, didConfirm: () => this.transitionToEditRoute() })` is Discourse's
 * dialog service, and `Modal.confirm({ ..., async onOk() {} })` is Ant Design's. Neither returns
 * the answer: the branch that runs on yes is an argument, and nothing happens on no. These are
 * gates with teeth, written the way their own libraries document, and ten of the fourteen findings
 * left on the corpus at one point were this single shape.
 */
const HANDLED = /\b(?:didConfirm|didCancel|onConfirm|onCancel|onOk|onYes|onNo|onApprove|onDeny|then|catch|callback|if_confirmed|ifConfirmed)\s*[:(]/;

const lineOf = (text: string, at: number): number => text.slice(0, at).split(NL).length;
const quote = (text: string, at: number): string => {
  const from = text.lastIndexOf(NL, at) + 1;
  const to = text.indexOf(NL, at);
  return text.slice(from, to === -1 ? text.length : to).trim().slice(0, 160);
};

/** The question as it was written, so the report can show what the person was asked. */
function questionIn(withStrings: string, at: number): string | null {
  const literal = /["'`]([^"'`]{4,120})["'`]/.exec(argumentsOf(withStrings, at));
  return literal ? literal[1].trim() : null;
}

/** Every gate in this file whose answer cannot change what happens next. */
export function toothlessGates(file: string, text: string, blanked?: Blanked): ToothlessGate[] {
  const python = /\.py$/i.test(file);
  const parts = blanked ?? blank(text, python);
  const code = parts.calls;
  const found: ToothlessGate[] = [];
  const seen = new Set<number>();

  const consider = (at: number, call: string): void => {
    if (seen.has(at)) return;
    if (isDeclaration(code, at, python)) return;
    // Too long to read to the end, so nothing is concluded from what is missing: the handler that
    // makes a dialog a real gate is the last thing in its options object, and a verdict drawn from
    // the part that fit would be drawn from the part that did not.
    if (!callFits(code, at)) return;
    // A library that hands the answer to a callback has already used it.
    if (HANDLED.test(argumentsOf(code, at))) return;
    // From the start of the whole expression, so a receiver chain is not read as context.
    const from = expressionStart(code, at);
    const before = code.slice(statementStart(code, from), from);
    const record = (why: ToothlessGate['why']): void => {
      seen.add(at);
      found.push({ file, line: lineOf(text, at), gate: call.replace(/\s*\($/, ''), asked: questionIn(parts.code, at), why, evidence: quote(text, at) });
    };

    if (USED_HERE.test(before)) {
      const named = ASSIGNED.exec(before);
      // Used in a condition, or handed to something. Either way the answer is not thrown away.
      if (!named) return;
      // Kept in a name. The gate has teeth only if something looks at that name again.
      const name = (named[1].split('.').pop() ?? named[1]).replace(/^#/, '');
      if (new RegExp(String.raw`\b${name}\b`).test(restOfBody(code, at + call.length, python))) return;
      record('its answer is put in a name nothing reads again');
      return;
    }
    record('its answer is thrown away where it is asked');
  };

  for (const hit of code.matchAll(GATES)) consider(hit.index ?? 0, hit[0]);
  for (const hit of code.matchAll(PY_INPUT)) {
    const at = hit.index ?? 0;
    // `input()` counts only where the prompt reads like a confirmation, which is also the evidence.
    if (!ASKS_IN_WORDS.test(argumentsOf(parts.code, at))) continue;
    consider(at, hit[0]);
  }
  return found.sort((a, b) => a.line - b.line);
}
