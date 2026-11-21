// Finding the individual tests in a file, and their bodies, without a parser per language.
//
// A parser for each of six languages is not the job, and would be the whole job. What is needed is
// narrower: where each test starts, what text belongs to it, and whether it was marked as skipped.
// Everything after this reads that text. Where the shape is not recognised, the file is reported as
// unread rather than judged - a file Tewip cannot see into is not a file full of worthless tests.
import { bracedTests, jsTests, pythonTests, rubyTests } from './find-tests.ts';
import { C_COMMENTS, closingSlash, opensRegex, REGEX_LITERALS } from './slash.ts';

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
/**
 * Languages Tewip knows exist and cannot read, by extension.
 *
 * An explicit list rather than "anything `languageOf` refuses". A denylist of everything Tewip
 * cannot parse would sweep in every `.md`, `.json`, `.lock` and `.png` in the repository and the
 * front door would start warning people about their README. This names the cases where somebody
 * would reasonably expect test support and will not get it, and stays silent otherwise - a report
 * that names a gap it is not sure about teaches people to skim the gaps.
 *
 * Adding a language to `languageOf` means deleting its line here. `engine/test/start.test.ts` fails
 * if a language appears in both, because claiming to read something and warning that you cannot is
 * worse than either on its own.
 */
export const CANNOT_READ: Record<string, string> = {
  dart: 'Dart',
  swift: 'Swift',
  m: 'Objective-C',
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  clj: 'Clojure',
  hs: 'Haskell',
  lua: 'Lua',
  jl: 'Julia',
  r: 'R',
  pl: 'Perl',
};

export const unreadableOf = (name: string): string | null => {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return CANNOT_READ[name.slice(dot + 1).toLowerCase()] ?? null;
};

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
  // Undefined means both, which is right for JavaScript - the language of the two callers that
  // cannot say, `withoutText` and `candidateMutants`. Every caller that knows now says so.
  const slashComments = language === undefined || C_COMMENTS.has(language);
  const regexes = language === undefined || REGEX_LITERALS.has(language);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (slashComments && ch === '/' && next === '/') {
      const end = indexOrEnd(text, String.fromCharCode(10), i);
      ranges.push([i, end]);
      i = end;
    } else if (slashComments && ch === '/' && next === '*') {
      const end = indexOrEnd(text, '*/', i) + 1;
      ranges.push([i, end]);
      i = end;
    } else if (regexes && ch === '/' && opensRegex(text, i)) {
      // A regular expression literal is text, not code, and it is full of both. A quote inside one
      // used to open a string that ran to the end of the file: `engine/test/action-manifest.test.ts`
      // has `/["']?composite/` on line 39, and the phantom string that opened there swallowed
      // 1,253 characters and five of the file's six tests. `vouch` read **none** of them and
      // reported a clean 136 files, because a file it cannot parse was dropped without a word.
      //
      // Masking the contents also stops a pattern *about* tests being read as one: Tewip's own
      // `engine/review/expectations.ts` holds `/\b(?:it|test|describe)\b/` and was a test file.
      const end = closingSlash(text, i);
      if (end === -1) continue; // division after all
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
 * literals and comments - all of which can hold a brace that closes nothing.
 *
 * This comment claimed to skip regular expressions from the day it was written, and the code had
 * no branch for them until Phase 201 - which cost more than the wording. A quote inside a regex
 * opened a string here too, so the brace counting went past the real closing brace and the whole
 * test was returned as unread. With a quote in a regex on its first line, a three-test file came
 * back as **0 of 3**: two declarations masked by the phantom string, and the third lost to this.
 */
export function braced(text: string, open: number, language?: Language): string | null {
  const slashComments = language === undefined || C_COMMENTS.has(language);
  const regexes = language === undefined || REGEX_LITERALS.has(language);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (slashComments && ch === '/' && next === '/') {
      i = indexOrEnd(text, String.fromCharCode(10), i);
      continue;
    }
    if (slashComments && ch === '/' && next === '*') {
      i = indexOrEnd(text, '*/', i) + 1;
      continue;
    }
    if (regexes && ch === '/' && opensRegex(text, i)) {
      const end = closingSlash(text, i);
      // A brace inside a regular expression closes nothing: `/x{2}/` is a quantifier, and before
      // this it decremented the depth and ended the test body early.
      if (end !== -1) i = end;
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

/**
 * Where a test's body actually starts.
 *
 * Taking the first `{` after the title is right until the callback destructures its argument:
 *
 *     it.each(components)('transforms $name', ({ name, className }) => {
 *       expect(componentNameToClassName(name)).toBe(className)
 *     })
 *
 * The first `{` there belongs to the parameter list, so the body read back was `{ name, className }`
 * - which contains no assertion, and the test was reported as one only a crash could fail.
 *
 * Measured on alphagov/govuk-frontend, the UK government's design system and the first real
 * JavaScript project this was ever pointed at: 21 accusations across 1,817 tests, and 19 of them
 * were this. Nineteen correct tests told they check nothing.
 *
 * A brace is a parameter list when what follows its match is `)` and then an arrow or the body's
 * own brace. Anything else is the body.
 */
export function bodyBrace(text: string, from: number): number {
  let open = text.indexOf('{', from);
  for (let guard = 0; open !== -1 && guard < 4; guard += 1) {
    const inside = braced(text, open);
    if (inside === null) return -1;
    const after = text.slice(open + inside.length + 2, open + inside.length + 24);
    if (!/^\s*\)\s*(=>|\{)/.test(after)) return open;
    open = text.indexOf('{', open + inside.length + 2);
  }
  return open;
}
