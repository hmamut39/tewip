// Small text operations the vouch rules share.
//
// Split out in Phase 44 so that `swallowed.ts` could use them without importing the module that
// imports it. Nothing here knows what a test is; they are string surgery and nothing more.

/** Comments cannot assert, and a commented-out check is the classic way a test stops checking. */
export function withoutComments(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(String.fromCharCode(10))
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/(^|\s)#(?!\{).*$/, ''))
    .join(String.fromCharCode(10));
}

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
