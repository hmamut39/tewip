// What a call looks like in the source: its arguments, where its expression begins, whether it is
// a definition, and where its statement starts.
//
// Split out of `gate-refuses.ts` when that file crossed this project's 300-line rule. Every
// function here exists because the ASI09 check got something wrong on real code, and the comment
// above each one names the project and the finding. That is why they are worth keeping together
// rather than folding back in: none of them knows anything about gates, they are about reading a
// call, and the next check that has to read one should not learn these six lessons again.
//
// All of them expect the blanked `calls` text, where string and comment contents are spaces, so a
// bracket inside a string cannot move a statement boundary. The indices line up with the original.
const NL = String.fromCharCode(10);

/** How far any of these will read before giving up. */
export const WINDOW = 4000;

/**
 * The call's own argument list.
 *
 * Read from whichever text the caller passes: `blanked.calls` to look for structure, `blanked.code`
 * to quote a string the arguments contain, which is why this takes the text rather than reaching
 * for one.
 */
export function argumentsOf(text: string, from: number): string {
  const open = text.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < text.length && i < open + WINDOW; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  // Ran out of window before the call closed. `callFits` is how a caller asks about this case
  // before relying on the answer; what was read is still returned, for a caller that only wants to
  // quote something out of it.
  return text.slice(open + 1, Math.min(text.length, open + WINDOW));
}

/**
 * Whether the call closes inside the window, which is whether its arguments can be trusted.
 *
 * It matters because of what lives at the end of a long argument list. nocodb's `Modal.confirm({
 * title, okText, cancelText, async onOk() { ... } })` is one call of 1,900 characters and the
 * handler that makes it a real gate is the last thing in it. A check that reads part of an
 * argument list and draws a conclusion from the absence of something is drawing it from the part
 * it could not read - so a caller that cares should ask this and say nothing instead.
 */
export function callFits(text: string, from: number): boolean {
  const open = text.indexOf('(', from);
  if (open === -1) return false;
  let depth = 0;
  for (let i = open; i < text.length && i < open + WINDOW; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

/**
 * Where the whole expression begins, with the receiver chain walked back over.
 *
 * `await this.jobService.getApproval(job)` is a call to `getApproval`, and the character before the
 * name is a `.` - so a test applied at the name's own position sees `this.jobService.` and finds
 * none of the words that would mean the answer was used. Before this existed, the gate check
 * reported `if (!(await this.jobService.getApproval(job)))` as a gate whose answer is thrown away:
 * a correct implementation, accused for having a receiver. Fourteen of its findings on n8n were
 * this and nothing else.
 *
 * `#` is in the class for a private field. Discourse writes `await this.#dialog.confirm({...})` and
 * reads the answer two lines later; without the `#` the walk stopped on it and the assignment was
 * read as a discard.
 */
export function expressionStart(code: string, at: number): number {
  let i = at;
  while (i > 0 && /[\w$.#[\]'"]/.test(code[i - 1])) i -= 1;
  return i;
}

/**
 * The call is a definition rather than a use.
 *
 * `async function confirm(message: string, config)` and `async confirm(req, res)` both match a
 * pattern looking for `confirm(`, and a definition has no answer to throw away - it is the thing
 * that produces one. Four corpus findings were a project's own helper reported for existing.
 *
 * Decided by what follows the argument list rather than by what precedes it, because the words in
 * front of a definition differ in every language and framework - `function`, `def`, `async`,
 * `public static`, a decorator, nothing at all - while what comes after does not: a definition's
 * arguments are followed by its body, and a call's never are.
 */
export function isDeclaration(code: string, at: number, python: boolean): boolean {
  const open = code.indexOf('(', at);
  if (open === -1) return false;
  let depth = 0;
  for (let i = open; i < code.length && i < open + WINDOW; i += 1) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth > 0) continue;
      const rest = code.slice(i + 1, i + 200);
      // Python's body marker *is* a colon, so the TypeScript return-type strip must not run here.
      // It did, and it ate the colon: Saleor's `def confirm(payment, manager: "PluginsManager") ->
      // Optional[PaymentTransaction]:` was reported as a confirmation whose answer is discarded,
      // which is a function being accused of existing. The annotation before the colon is what hid
      // it from the first attempt at this.
      if (python) return /^\s*(?:->[^:\n]*)?\s*:/.test(rest);
      // TypeScript: skip whitespace, and a return type if there is one.
      return rest.replace(/^\s*(?::\s*[^;{=]+)?/, '').startsWith('{');
    }
  }
  return false;
}

/**
 * The start of the statement a call sits in.
 *
 * Walking backwards cannot answer this, and two attempts at it are the evidence. Going back from
 * the call, the line break ending the previous line arrives *before* the bracket that is still
 * open - so the walk stops at the newline, decides the call begins its own statement, and never
 * sees what encloses it. Nothing available at that moment distinguishes the two cases:
 *
 *     const confirmed = await withCancelHandler(
 *       confirm({ message: 'Are you sure you want to disable cloud support?' }),
 *     );
 *     if (!confirmed) return;
 *
 * That is n8n's node CLI and it is a correct gate, reported twice while this read a line break as a
 * statement boundary. So the scan runs forwards from the enclosing block, where the depth is known,
 * and a line break only starts a statement when no bracket is open at it.
 */
export function statementStart(code: string, at: number): number {
  const floor = blockStart(code, at);
  let start = floor;
  let depth = 0;
  for (let i = floor; i < at; i += 1) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if ((ch === NL || ch === ';') && depth === 0) start = i + 1;
  }
  return start;
}

/**
 * The innermost enclosing block, which is where a forward scan can start with the depth at zero.
 *
 * Braces only, because a block is what gives a statement its level: the body of a function, an
 * `if`, a class. Python has none to find, so the walk runs to the end of the window and the floor
 * is used - which is right for it, since a Python statement not inside brackets starts at a line
 * break.
 */
function blockStart(code: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0 && at - i < WINDOW; i -= 1) {
    const ch = code[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) return i + 1;
      depth -= 1;
    }
  }
  return Math.max(0, at - WINDOW);
}

/**
 * The rest of the function body a position sits in, so "nothing reads it again" is a question about
 * this function rather than about the file.
 *
 * Crude in the safe direction, like `sameBody` in the taint engine. For Python there are no braces
 * to count, so the body runs to the next line starting in the first column - which is where the
 * enclosing `def` must have ended.
 */
export function restOfBody(code: string, at: number, python: boolean): string {
  if (python) {
    const rest = code.slice(at);
    const next = /\n(?=[^\s#])/.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
  }
  let depth = 0;
  for (let i = at; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth === 0) return code.slice(at, i);
      depth -= 1;
    }
  }
  return code.slice(at);
}
