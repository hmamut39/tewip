// Small text operations the vouch rules share.
//
// Split out in Phase 44 so that `swallowed.ts` could use them without importing the module that
// imports it. Nothing here knows what a test is; they are string surgery and nothing more.

// Comments cannot assert, and a commented-out check is the classic way a test stops checking.
//
// Written with line comments rather than a block, because the example below contains the exact
// character sequence that ends one - which is the whole point of the bug.
//
// This used to be a regex that replaced everything from a slash-star to the next star-slash, and a
// regex cannot tell a comment from a string that happens to contain one. gin's TestParseAccept
// parses an HTTP Accept header, and the media type `*/*` contains both sequences:
//
//     parts := parseAccept("text/html , application/xml;q=0.9,  */* ;q=0.8")
//     assert.Len(t, parts, 4)
//     assert.Equal(t, "text/html", parts[0])
//     ...
//     assert.Equal(t, "*/*", parts[3])
//
// A comment was opened inside the first string and closed in the last assertion. Everything
// between - all five assertions - became a single space, and a thoroughly checked test was
// reported as one that compares no value and only a crash could fail. Found on gin-gonic/gin, the
// first real Go project this was ever pointed at.
//
// So the text is walked instead, and a quoted string is skipped whole - which is what the rules
// above already assumed: "Strings are blanked as well as comments".
export function withoutComments(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const next = body[i + 1] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = endOfString(body, i);
      out += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = body.indexOf('*/', i + 2);
      // Only when it closes. An unclosed one was treated as running to the end of the body, on the
      // reasoning that a compiler would do the same - but a compiler is reading a language that has
      // block comments, and this is handed every language. Ruby has none, and discourse writes
      //
      //     %r{https://matrix.org/_matrix/client/r0/rooms/!blah/send/m.room.message/*}
      //
      // where the `/*` is the end of a regex literal. Running to the end of the body deleted the
      // three assertions below it and reported two thoroughly checked tests as crash-only. A file
      // that really ends inside a block comment does not compile; a regex containing `/*` is
      // ordinary. The old regex required the closing `*/` and was right to.
      if (close === -1) {
        out += ch;
        continue;
      }
      out += ' ';
      i = close + 1;
      continue;
    }
    const atLineStart = i === 0 || /\s/.test(body[i - 1] ?? '');
    // `http://x` is not a comment, which is why the start of the line or a space is required.
    if (ch === '/' && next === '/' && atLineStart) {
      i = indexOrEnd(body, i) - 1;
      continue;
    }
    if (ch === '#' && next !== '{' && atLineStart) {
      i = indexOrEnd(body, i) - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Where the string opening at `from` ends, honouring backslash escapes. */
function endOfString(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === quote) return i;
  }
  return text.length - 1;
}

/** The newline at or after `from`, or the end of the text. */
const indexOrEnd = (text: string, from: number): number => {
  const at = text.indexOf(String.fromCharCode(10), from);
  return at === -1 ? text.length : at;
};

export const stripLines = (body: string, lines: string[]): string =>
  body
    .split(String.fromCharCode(10))
    .filter((line) => !lines.some((drop) => line.trim() === drop.trim()))
    .join(String.fromCharCode(10));

/** The first line that does something, for the report to quote. */
export function firstRealLine(body: string): string {
  const lines = body
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== '{' && l !== '}');
  // A comment is not the evidence. Saleor's tests are written `# given` / `# when / then`, so the
  // quoted evidence for 166 real findings was the single character "#", which tells a reader
  // nothing about the test it is accusing. The line that does something is the evidence.
  // Nor is a line with nothing in it but punctuation: a lone quote closing a docstring, a stray
  // bracket. Evidence has to be something a reader can recognise as the test doing work.
  const code = lines.find((l) => !/^(#|\/\/|\/\*|\*|"""|'''|--)/.test(l) && /[A-Za-z0-9]/.test(l));
  return (code ?? lines[0] ?? '').slice(0, 120);
}


export const balanced = (text: string, open: number): string | null => {
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
};
