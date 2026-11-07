// Reading source as source: one scanner that knows a comment from a string from a pattern.
//
// Both halves of this module needed it and both got it wrong in a different direction first, which
// is the argument for having it once.
//
// `tools.ts` blanked comments with a plain regex and lost three real tools from the official MCP
// filesystem server - `copy_file`, `move_file`, `search_files` - because a glob in a string holds
// `/*`, so "blank from `/*` to the next `*/`" ate the code between two unrelated path patterns.
//
// `guards.ts` blanked strings without stripping comments first, and an apostrophe in an English
// sentence - "Tewip's own server" - opened a string that stayed open for the rest of the file, so
// every later line was one quote out of step and the checker found its own regex and reported it
// as a human approval gate.
//
// Both are the same mistake: deciding what a character means without tracking what you are inside.
const NL = String.fromCharCode(10);
const blankOut = (s: string) => s.replace(/[^\n]/g, ' ');

export interface Blanked {
  /** Comments gone, string contents kept: for finding a tool's name, which *is* a string. */
  code: string;
  /** Comments and string and pattern contents all gone: for finding a call, which is never one. */
  calls: string;
}

/**
 * One pass, both answers, lengths and line breaks preserved throughout.
 *
 * Keeping the length means every index into either result still points at the same place in the
 * original, which is what lets a tool's description be read back out of the untouched source after
 * the docstring it lives in has been blanked for matching.
 */
export function blank(text: string, python: boolean): Blanked {
  const code: string[] = [];
  const calls: string[] = [];
  const keep = (s: string) => {
    code.push(s);
    calls.push(s);
  };
  const drop = (s: string) => {
    code.push(blankOut(s));
    calls.push(blankOut(s));
  };
  let before = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);

    // A comment is blanked in both, because nothing in one is code.
    if ((python && text[i] === '#') || (!python && two === '//')) {
      const end = text.indexOf(NL, i);
      const stop = end === -1 ? text.length : end;
      drop(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (!python && two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      drop(text.slice(i, stop));
      i = stop;
      continue;
    }
    // A Python docstring is documentation, and a framework documents its own decorator by showing
    // it being used. crewAI's `@tool` docstring contains `@tool` and `def greet(...)`.
    if (python && (three === '"""' || three === "'''")) {
      const end = text.indexOf(three, i + 3);
      const stop = end === -1 ? text.length : end + 3;
      drop(text.slice(i, stop));
      i = stop;
      continue;
    }

    const ch = text[i];
    const quote = ch === '"' || ch === "'" || ch === '`';
    // A regex literal, not a division: only where an expression cannot have just ended.
    const regex = !python && ch === '/' && (before === '' || '(,=:[!&|?{};+*'.includes(before));
    if (!quote && !regex) {
      keep(ch);
      if (!/\s/.test(ch)) before = ch;
      i += 1;
      continue;
    }

    const close = quote ? ch : '/';
    let j = i + 1;
    while (j < text.length && text[j] !== close) {
      if (text[j] === '\\') {
        j += 2;
        continue;
      }
      // An unterminated quote must not swallow the file; only a backtick spans lines.
      if (text[j] === NL && quote && ch !== '`') break;
      j += 1;
    }
    const inner = text.slice(i + 1, j);
    const closer = text[j] ?? '';
    code.push(ch, inner, closer);
    calls.push(ch, blankOut(inner), closer);
    before = closer || before;
    i = j + 1;
  }
  return { code: code.join(''), calls: calls.join('') };
}
