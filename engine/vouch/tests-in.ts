// Finding the individual tests in a file, and their bodies, without a parser per language.
//
// A parser for each of six languages is not the job, and would be the whole job. What is needed is
// narrower: where each test starts, what text belongs to it, and whether it was marked as skipped.
// Everything after this reads that text. Where the shape is not recognised, the file is reported as
// unread rather than judged - a file Tewip cannot see into is not a file full of worthless tests.
export interface FoundTest {
  name: string;
  /** 1-based, so it can be printed beside the file and clicked. */
  line: number;
  body: string;
  /** Marked skipped, disabled or ignored: it proves nothing because it never runs. */
  skipped: boolean;
  /**
   * The name of a plain callback parameter where the test takes one - Mocha's `done`. A test handed
   * one fails when it is never called, which is a real check even with nothing asserted, so the
   * judging has to know. A destructured parameter is not this: Playwright's `async ({ page }) =>`
   * receives fixtures, not a callback.
   */
  callback: string;
}

export type Language = 'js' | 'python' | 'jvm' | 'go' | 'csharp';

/** Which language this file is, by extension. Unknown extensions are not guessed at. */
export function languageOf(file: string): Language | null {
  const lower = file.toLowerCase();
  if (/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(lower)) return 'js';
  if (lower.endsWith('.py')) return 'python';
  if (/\.(java|kt|kts|scala|groovy)$/.test(lower)) return 'jvm';
  if (lower.endsWith('.go')) return 'go';
  if (/\.(cs|fs)$/.test(lower)) return 'csharp';
  return null;
}

/** Does this file look like tests at all? Vouching for a source file is a category error. */
export function looksLikeTests(file: string, text: string): boolean {
  const named = /(^|[\\/])(tests?|spec|specs|__tests__|e2e|it|integration)[\\/]|[._-](test|tests|spec|specs|it)\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs|scala)$/i.test(file);
  const declares = /\b(it|test|describe|Scenario)\s*\(|^\s*def\s+test_|@Test\b|\[(Test|Fact|Theory)\]|\bfunc\s+Test[A-Z]/m.test(text);
  return named || declares;
}

/**
 * The offsets of this file that are inside a string, a template literal or a comment - text, not
 * code. Test files are full of test code that is not test code: fixtures quoting a fake test,
 * snapshots, documentation examples, and the input to tools like Tewip itself. Judging those is how
 * a checker ends up telling somebody that a string in their fixture checks nothing. Found by
 * pointing this at Tewip's own test suite, where it produced 27 confident false accusations.
 */
export function textRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const TRIPLES = ['"'.repeat(3), "'".repeat(3)];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = indexOrEnd(text, String.fromCharCode(10), i);
      ranges.push([i, end]);
      i = end;
    } else if (ch === '/' && next === '*') {
      const end = indexOrEnd(text, '*/', i) + 1;
      ranges.push([i, end]);
      i = end;
    } else if (ch === '#' && /[#\s]/.test(next ?? '')) {
      const end = indexOrEnd(text, String.fromCharCode(10), i);
      ranges.push([i, end]);
      i = end;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // A Python docstring runs to the next triple quote, not to the next single one.
      const triple = TRIPLES.find((t) => text.startsWith(t, i));
      const end = triple ? indexOrEnd(text, triple, i + 2) + 2 : closingQuote(text, i);
      ranges.push([i, end]);
      i = end;
    }
  }
  return ranges;
}

/** Is this offset inside text rather than code? */
const isText = (ranges: Array<[number, number]>, at: number): boolean => ranges.some(([from, to]) => at > from && at < to);

export function testsIn(language: Language, text: string): FoundTest[] {
  if (language === 'python') return pythonTests(text);
  if (language === 'js') return jsTests(text);
  return bracedTests(language, text);
}

/** The line number of an offset, 1-based. */
const lineAt = (text: string, index: number): number => text.slice(0, index).split(String.fromCharCode(10)).length;

/**
 * `it('...', async () => { ... })` and its many spellings, including `test.each`, `it.skip` and a
 * plain `function ()` callback. The body is taken by matching braces from the callback's opening one.
 */
function jsTests(text: string): FoundTest[] {
  const found: FoundTest[] = [];
  const ranges = textRanges(text);
  const declaration = /\b(it|test|specify)\s*(\.\s*(skip|only|todo|failing|concurrent|each|for)\s*(\([^)]*\)|`[^`]*`)?\s*)*\(\s*(['"`])((?:\\.|(?!\5)[^\\])*)\5/g;
  for (const hit of text.matchAll(declaration)) {
    const at = hit.index ?? 0;
    if (isText(ranges, at)) continue;
    const open = text.indexOf('{', at + hit[0].length);
    if (open === -1) continue;
    const body = braced(text, open);
    if (body === null) continue;
    const signature = text.slice(at + hit[0].length, open);
    found.push({
      name: hit[6],
      line: lineAt(text, at),
      body,
      skipped: /\.\s*(skip|todo|failing)\b/.test(hit[0]) || /\bxit\s*\(/.test(hit[0]),
      callback: /\(\s*([A-Za-z_$][\w$]*)\s*\)\s*(=>)?\s*$/.exec(signature.trim())?.[1] ?? '',
    });
  }
  // `xit(...)` and `xtest(...)`, which the pattern above deliberately does not match.
  for (const hit of text.matchAll(/\bx(it|test)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g)) {
    const at = hit.index ?? 0;
    if (isText(ranges, at)) continue;
    const open = text.indexOf('{', at + hit[0].length);
    const body = open === -1 ? null : braced(text, open);
    found.push({ name: hit[3], line: lineAt(text, at), body: body ?? '', skipped: true, callback: '' });
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Python has no braces: a test's body is everything indented further than its `def`. */
function pythonTests(text: string): FoundTest[] {
  const lines = text.split(String.fromCharCode(10));
  const ranges = textRanges(text);
  const offsets: number[] = [];
  let seen = 0;
  for (const line of lines) {
    offsets.push(seen);
    seen += line.length + 1;
  }
  const found: FoundTest[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const hit = /^(\s*)(?:async\s+)?def\s+(test_\w+|test)\s*\(/.exec(lines[i]);
    if (!hit) continue;
    if (isText(ranges, offsets[i] + hit[1].length + 1)) continue;
    const indent = hit[1].length;
    // Nested in another def? Then it is a helper or, in Click's tests, a CLI command that happens to
    // be named `test`. Only a module-level def, or a method of a test class, is a test.
    if (nestedInFunction(lines, i, indent)) continue;
    if (hit[2] === 'test' && indent > 0) continue;
    // A def whose parameters run over several lines ends at the line that closes them, and the body
    // starts after that. Without this, the parameter list was read as the body and the real body was
    // thrown away: psf/requests has several, and each came back as a test that compares no value.
    let signatureEnds = i;
    let open = 0;
    for (let j = i; j < lines.length && j < i + 20; j += 1) {
      open += (lines[j].match(/\(/g) ?? []).length - (lines[j].match(/\)/g) ?? []).length;
      signatureEnds = j;
      if (open <= 0) break;
    }

    const body: string[] = [];
    for (let j = signatureEnds + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      const width = line.length - line.trimStart().length;
      if (width <= indent) break;
      body.push(line);
    }
    // Decorators sit above the def, so skipping is read upwards.
    const above = lines.slice(Math.max(0, i - 4), i).join(String.fromCharCode(10));
    // A conditional skip runs somewhere - `skipif` on Windows registry tests in psf/requests runs
    // on Windows - so only an unconditional skip means the test never runs. `xfail` runs too.
    const skipped = /@\s*(pytest\s*\.\s*mark\s*\.\s*skip|unittest\s*\.\s*skip)\b/.test(above) && !/skipif|skipUnless|xfail/.test(above);
    found.push({ name: hit[2], line: i + 1, body: body.join(String.fromCharCode(10)), skipped, callback: '' });
  }
  return found;
}

/** Is the def on line `i` nested inside another def, rather than inside a class or at the top? */
function nestedInFunction(lines: string[], i: number, indent: number): boolean {
  for (let j = i - 1; j >= 0; j -= 1) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const width = line.length - line.trimStart().length;
    if (width >= indent) continue;
    return /^\s*(async\s+)?def\s/.test(line);
  }
  return false;
}

/** JUnit, Kotlin, Scala, Go and C#: an annotation or a naming convention, then a braced body. */
function bracedTests(language: Language, text: string): FoundTest[] {
  const found: FoundTest[] = [];
  const ranges = textRanges(text);
  const declaration =
    language === 'go'
      ? // Only a Test function. A Benchmark asserts nothing by design, an Example is checked against
        // its own Output comment, and a Fuzz target is not a test - all three were condemned as
        // "checks nothing" in gorilla/mux before this narrowed.
        /\bfunc\s+(Test)(\w+)\s*\(\s*\w+\s+\*testing\.[TB]\s*\)\s*\{/g
      : /(@Test\b[^\n]*|\[\s*(?:Test|Fact|Theory)[^\]]*\]|@(?:ParameterizedTest|RepeatedTest)\b)/g;
  for (const hit of text.matchAll(declaration)) {
    const at = hit.index ?? 0;
    if (isText(ranges, at)) continue;
    const open = language === 'go' ? text.indexOf('{', at) : text.indexOf('{', text.indexOf('(', at + hit[0].length));
    if (open === -1) continue;
    const body = braced(text, open);
    if (body === null) continue;
    const signature = text.slice(at, open);
    // `void foo() throws IOException` still names foo. Without allowing the throws clause, every
    // checked-exception test in gson was reported as 'unnamed'.
    const name = language === 'go' ? hit[1] + hit[2] : /([\w]+)\s*\([^)]*\)\s*(throws\s+[\w.,\s]+)?$/.exec(signature.trim())?.[1] ?? 'unnamed';
    const around = text.slice(Math.max(0, at - 200), open);
    // An annotation disables a test outright. A `t.Skip()` may be conditional - cobra's
    // TestDeadcodeElimination skips on Windows and runs everywhere else - so it counts only when it
    // is unconditional, at the top level of the body.
    const skipped = /@(Disabled|Ignore)\b|\[\s*Ignore\b/.test(around) || skipsUnconditionally(body);
    found.push({ name, line: lineAt(text, at), body, skipped, callback: '' });
  }
  return found;
}

/**
 * A `t.Skip()` that runs whatever happens: at the top level of the body, not inside an `if`. Go
 * tests commonly skip on one platform and run on the others, and calling those "never runs" is
 * wrong.
 */
function skipsUnconditionally(body: string): boolean {
  let depth = 0;
  for (const line of body.split(String.fromCharCode(10))) {
    const text = line.trim();
    if (depth === 0 && /^\w+\s*\.\s*Skip(Now)?\s*\(/.test(text)) return true;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return false;
}

/**
 * The text between the brace at `open` and the one that closes it, skipping over strings, template
 * literals, comments and regular expressions - all of which can hold a brace that closes nothing.
 */
export function braced(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      i = indexOrEnd(text, String.fromCharCode(10), i);
      continue;
    }
    if (ch === '/' && next === '*') {
      i = indexOrEnd(text, '*/', i) + 1;
      continue;
    }
    if (ch === '#' && /[#\s]/.test(next ?? '')) {
      i = indexOrEnd(text, String.fromCharCode(10), i);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = closingQuote(text, i);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const indexOrEnd = (text: string, needle: string, from: number): number => {
  const at = text.indexOf(needle, from + 1);
  return at === -1 ? text.length : at;
};

/** Where the string opening at `from` ends, honouring escapes. */
function closingQuote(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i;
  }
  return text.length;
}
