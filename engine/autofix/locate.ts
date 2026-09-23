// Finds where a failing locator is written in a spec file, so the auto-fix loop can rewrite
// exactly that call and nothing else.

export interface LocatorSite {
  start: number;
  end: number;
  text: string;
  /** 1-based line of the call. */
  line: number;
}

const CALL_START = /\b(?:locator|getBy(?:Role|Text|Label|TestId|Placeholder|Title|AltText))\(/g;

/** Canonical form for comparing source text with the locator Playwright printed. */
export function normalizeLocator(s: string): string {
  return s.replaceAll('"', "'").replace(/\s+/g, '').replace(/,([}\)])/g, '$1');
}

/** Index just past the ")" that closes the "(" at `open`, skipping strings; -1 if unbalanced. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** The last call in a printed chain, e.g. "locator('#a').locator('.b')" -> "locator('.b')". */
export function lastCall(printed: string): string {
  const starts = [...printed.matchAll(CALL_START)].map((m) => m.index!);
  if (starts.length === 0) return printed;
  const start = starts[starts.length - 1];
  const end = closeParen(printed, printed.indexOf('(', start));
  return end > 0 ? printed.slice(start, end) : printed.slice(start);
}

/** Every call in `source` that is the same locator as `printed` (its last call). */
export function findLocatorSites(source: string, printed: string): LocatorSite[] {
  const want = normalizeLocator(lastCall(printed));
  const sites: LocatorSite[] = [];
  for (const m of source.matchAll(CALL_START)) {
    const start = m.index!;
    const end = closeParen(source, start + m[0].length - 1);
    if (end < 0) continue;
    const text = source.slice(start, end);
    if (normalizeLocator(text) === want) sites.push({ start, end, text, line: source.slice(0, start).split('\n').length });
  }
  return sites;
}

/** Line of `specFile` in a stack trace ("at …/shop.spec.ts:12:5"), or null. */
export function failingLine(stack: string, specFile: string): number | null {
  const name = specFile.split(/[\\/]/).pop()!;
  for (const line of stack.split('\n')) {
    const m = line.match(/[\\/]([^\\/:]+):(\d+):\d+\)?\s*$/);
    if (m && m[1] === name) return Number(m[2]);
  }
  return null;
}

/**
 * True when the test still checks something after `line`: without an expect() after the
 * rewritten call, a passing re-run would prove nothing about the fix.
 */
export function hasAssertionAfter(source: string, line: number): boolean {
  const lines = source.split('\n');
  for (let i = line - 1; i < lines.length; i++) {
    if (i > line - 1 && /^\s*test(\.\w+)?\(/.test(lines[i])) return false;
    if (ASSERTION.test(lines[i])) return true;
    if (/^\}\);?\s*$/.test(lines[i])) return false;
  }
  return false;
}

/**
 * What counts as checking something. `expect(` alone missed a whole framework: Cypress asserts with
 * `cy.get(...).should('be.visible')` and writes `expect(` only inside `.then()`. Six real Cypress
 * fixed-wait removals were refused as "nothing is asserted after the wait" when the very next line
 * was an assertion, which is how this was found. Python's bare `assert` counts for the same reason.
 */
const ASSERTION = /\bexpect\s*\(|\.should\s*\(|\bassert\s*[.(]|\bassert\s+|\bassertThat\s*\(/;
