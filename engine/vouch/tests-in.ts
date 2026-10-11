// Finding the individual tests in a file, and their bodies, without a parser per language.
//
// A parser for each of six languages is not the job, and would be the whole job. What is needed is
// narrower: where each test starts, what text belongs to it, and whether it was marked as skipped.
// Everything after this reads that text. Where the shape is not recognised, the file is reported as
// unread rather than judged - a file Tewip cannot see into is not a file full of worthless tests.
import { bracedTests, jsTests, pythonTests, rubyTests } from './find-tests.ts';

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

export type Language = 'js' | 'python' | 'jvm' | 'go' | 'csharp' | 'ruby' | 'php' | 'rust';

/** Which language this file is, by extension. Unknown extensions are not guessed at. */
export function languageOf(file: string): Language | null {
  const lower = file.toLowerCase();
  if (/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(lower)) return 'js';
  if (lower.endsWith('.py')) return 'python';
  if (/\.(java|kt|kts|scala|groovy)$/.test(lower)) return 'jvm';
  if (lower.endsWith('.go')) return 'go';
  if (/\.(cs|fs)$/.test(lower)) return 'csharp';
  // Phase 36. The assertion vocabulary already knew how these three check things - `expect(x).to`,
  // `$this->assert`, `assert_eq!` were all on the list - so the only reason a Ruby, PHP or Rust
  // file was never judged is that it never got this far. Triage has claimed all three for months.
  if (lower.endsWith('.rb')) return 'ruby';
  if (lower.endsWith('.php')) return 'php';
  if (lower.endsWith('.rs')) return 'rust';
  return null;
}

/** Does this file look like tests at all? Vouching for a source file is a category error. */
export function looksLikeTests(file: string, text: string): boolean {
  const named = /(^|[\\/])(tests?|spec|specs|__tests__|e2e|it|integration)[\\/]|[._-](test|tests|spec|specs|it)\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs|scala)$/i.test(file);
  const declares =
    /\b(it|test|describe|Scenario)\s*\(|^\s*def\s+test_|@Test\b|\[(Test|Fact|Theory)\]|\bfunc\s+Test[A-Z]/m.test(text) ||
    // Ruby, PHP and Rust, added in Phase 36. PHPUnit names a test `testSomething`, so the `test\s*\(`
    // above never matched it, and Rust marks one with an attribute no pattern here knew. Both came
    // back as "0 test(s) read in 0 file(s)", which reads like a clean answer and is not one.
    /#\s*\[\s*(?:test|tokio::test|rstest)\s*\]/.test(text) ||
    /\bfunction\s+test\w*\s*\(|#\s*\[\s*Test\b|\*\s*@test\b/.test(text) ||
    /^\s*(?:RSpec\.)?(?:describe|context)\s+|^\s*(?:x|f)?it\s+["'].*\bdo\b/m.test(text);
  return named || declares;
}

/**
 * The offsets of this file that are inside a string, a template literal or a comment - text, not
 * code. Test files are full of test code that is not test code: fixtures quoting a fake test,
 * snapshots, documentation examples, and the input to tools like Tewip itself. Judging those is how
 * a checker ends up telling somebody that a string in their fixture checks nothing. Found by
 * pointing this at Tewip's own test suite, where it produced 27 confident false accusations.
 */
/** A Rust char literal: `'a'`, `'\n'`, `'\''`. Anything else beginning with a quote is a lifetime. */
const RUST_CHAR = new RegExp(`^'(?:${String.raw`\\`}.|[^'${String.raw`\\`}])'`);

export function textRanges(text: string, language?: Language): Array<[number, number]> {
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
    } else if (ch === "'" && language === 'rust' && !RUST_CHAR.test(text.slice(i, i + 4))) {
      // A lone quote in Rust is a lifetime - `&'a str`, `Cow<'_, str>` - and not the start of
      // anything. Treating it as a quote made the detector swallow the rest of the file, so all
      // six of ripgrep's #[test] attributes were discarded as being inside a string and the file
      // was reported as having no tests at all. A char literal is still text, so it is matched
      // first: a char closes within three characters and a lifetime never closes.
      continue;
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
export const isText = (ranges: Array<[number, number]>, at: number): boolean => ranges.some(([from, to]) => at > from && at < to);

export function testsIn(language: Language, text: string): FoundTest[] {
  if (language === 'python') return pythonTests(text);
  if (language === 'js') return jsTests(text);
  if (language === 'ruby') return rubyTests(text);
  return bracedTests(language, text);
}

/** The line number of an offset, 1-based. */
export const lineAt = (text: string, index: number): number => text.slice(0, index).split(String.fromCharCode(10)).length;

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
