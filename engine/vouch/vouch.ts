// Phase 22: does this test prove anything?
//
// By 2026 most tests in a pull request were written by an agent, and the one question that decides
// whether they are worth anything goes unasked: could this test ever fail? Coverage counts a test
// that checks nothing. CI goes green on it. A reviewer skims something plausible and approves it.
//
// This file answers that per test, from the text alone, and its accuracy rests on refusing to guess.
// Telling somebody their test is worthless when it is not costs more than missing one: it spends
// their time and their trust, and a reviewer who is wrong once is ignored afterwards. So a body whose
// checking happens somewhere this cannot follow is reported as undecided, by name, and never as
// vacuous.
import { checksSomething, tautologies, unfinishedExpectations } from './assertions.ts';
import { languageOf, looksLikeTests, testsIn, textRanges, type FoundTest, type Language } from './tests-in.ts';

export type Verdict =
  | 'checks' // it can fail: something in it is asserted
  | 'crash-only' // it compares no value: it passes unless something throws
  | 'unfinished-expectation' // an expectation with no matcher: reads as a check, is not one
  | 'tautology' // the check compares something with itself
  | 'swallows-failure' // a failing assertion is caught and discarded
  | 'never-runs' // skipped, disabled or ignored
  | 'cannot-tell'; // the checking may be inside something this cannot follow

export interface Judgement {
  file: string;
  name: string;
  line: number;
  verdict: Verdict;
  /** The line that justifies the verdict, quoted, so nobody has to take it on faith. */
  evidence: string;
  /** Why, in a sentence a reviewer can act on. */
  why: string;
}

export interface FileVouch {
  file: string;
  judgements: Judgement[];
  /** Why nothing was judged here, when nothing was. */
  unread: string;
  /** A `.only` makes every other test in the file not run, which is a finding about the file. */
  focused: string;
}

/** Everything a verdict other than `checks` means, in the words the report uses. */
export const MEANS: Record<Verdict, string> = {
  checks: 'it asserts something, so it can fail',
  'crash-only': 'it compares no value, so it passes whatever the code returns; only an exception can fail it',
  'unfinished-expectation': 'an expectation was written but no matcher was called on it, so nothing is compared',
  tautology: 'the check compares a value with itself, which no change to the code can falsify',
  'swallows-failure': 'its own failure is caught and discarded, so it reports success either way',
  'never-runs': 'it is skipped, so it proves nothing until somebody turns it back on',
  'cannot-tell': 'the checking may happen inside a helper this cannot follow, so Tewip is not calling it either way',
};

/**
 * Tests that cannot fail at all, worst first.
 *
 * `crash-only` is deliberately not in this list, and that correction came from reading real code.
 * "It checks nothing, so it cannot fail" is false: a test with no assertion still fails when the
 * code throws, and in axios a test that compiles a TypeScript fixture and runs it asserts nothing
 * on purpose - the crash *is* the check. Tewip would have called 143 such tests worthless across
 * seven real projects. Overclaiming about somebody's tests is the exact failure this project exists
 * not to commit, so the two are reported apart and worded for what each really is.
 */
export const CANNOT_FAIL: Verdict[] = ['unfinished-expectation', 'tautology', 'swallows-failure', 'never-runs'];

/** Weaker than a check, and worth knowing, but not a defect on its own. */
export const CRASH_ONLY: Verdict[] = ['crash-only'];

export function vouchFile(file: string, text: string): FileVouch {
  const language = languageOf(file);
  if (!language) return { file, judgements: [], unread: 'Tewip does not read this kind of file', focused: '' };
  if (!looksLikeTests(file, text)) return { file, judgements: [], unread: 'this does not look like a test file, and vouching for source code is a different question', focused: '' };

  const tests = testsIn(language, text);
  if (tests.length === 0) {
    return { file, judgements: [], unread: 'no test in a shape Tewip recognises, so it says nothing about this file rather than clearing it', focused: '' };
  }

  const helpers = helpersThatCheck(text, language);
  // Masked the same way the extractor is: a `.only` quoted inside a fixture focuses nothing.
  const ranges = textRanges(text);
  const focus = [...text.matchAll(/\b(it|test|describe)\s*\.\s*only\s*\(|\bfdescribe\s*\(|\bfit\s*\(/g)].find(
    (hit) => !ranges.some(([from, to]) => (hit.index ?? 0) > from && (hit.index ?? 0) < to),
  );
  return {
    file,
    judgements: tests.map((test) => judge(file, test, helpers)),
    unread: '',
    focused: focus ? `${focus[0].trim()}…) is focused, so the rest of this file does not run` : '',
  };
}

function judge(file: string, test: FoundTest, helpers: Set<string>): Judgement {
  const at = { file, name: test.name, line: test.line };
  if (test.skipped) return { ...at, verdict: 'never-runs', evidence: test.name, why: MEANS['never-runs'] };

  // Strings are blanked as well as comments. A fixture that quotes `expect(true).toBe(true)` is not a
  // tautology, it is a test *about* tautologies - and before this, Tewip accused its own suite of
  // exactly that. The extractor learned this lesson in Phase 22; the verdicts had not, and it took a
  // recall measurement judging by execution to notice, because no ordinary project quotes test code in
  // its tests. Any checker's own tests do, and so does any test asserting on generated code.
  const body = withoutText(withoutComments(test.body));
  const tautology = tautologies(body);
  const unfinished = unfinishedExpectations(body);
  const checks = checksSomething(body);

  // A body that checks nothing else and contains only a tautology cannot fail. One alongside real
  // checks is untidy, not broken, so it is left alone.
  if (tautology.length > 0 && !checksSomething(stripLines(body, tautology))) {
    return { ...at, verdict: 'tautology', evidence: tautology[0], why: MEANS.tautology };
  }
  if (unfinished.length > 0 && !checksSomething(stripLines(body, unfinished))) {
    return { ...at, verdict: 'unfinished-expectation', evidence: unfinished[0], why: MEANS['unfinished-expectation'] };
  }
  const swallowed = swallowsFailure(body, checks);
  if (swallowed) return { ...at, verdict: 'swallows-failure', evidence: swallowed, why: MEANS['swallows-failure'] };
  if (checks) return { ...at, verdict: 'checks', evidence: '', why: MEANS.checks };

  // Mocha's `done`: the test fails when the callback never arrives, which is a real check with
  // nothing asserted. express has dozens, and calling them unchecked was simply wrong.
  if (test.callback && new RegExp('\\b' + test.callback + '\\b').test(body)) {
    return { ...at, verdict: 'checks', evidence: test.callback, why: `it fails if ${test.callback}() is never called, which is what it is checking` };
  }

  // Nothing in the body checks anything. Before saying so, look for the checking somewhere else:
  // a helper in this file that asserts, or a call this cannot follow at all.
  const called = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).filter((name) => !LANGUAGE_NOISE.has(name));
  const helping = called.find((name) => helpers.has(name));
  if (helping) return { ...at, verdict: 'checks', evidence: `${helping}(…)`, why: `it checks through ${helping}(), which asserts` };
  const unknown = called.find((name) => /^(check|verify|ensure|validate|assert|expect|should|confirm)/i.test(name));
  if (unknown) return { ...at, verdict: 'cannot-tell', evidence: `${unknown}(…)`, why: `${unknown}() may assert, and it is not in this file, so Tewip will not call this either way` };
  // A body whose whole content is one call to something defined in another file. The check is very
  // likely inside it, and Tewip cannot follow it there, so "it compares no value" would be a
  // confident wrong answer. Rails's own `test_constantize` is exactly this: one line calling
  // `run_constantize_tests_on`, which lives in a shared helper and asserts plenty.
  const statements = body
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('//'));
  if (statements.length === 1 && /^[A-Za-z_][\w.:]*\s*[({]/.test(statements[0])) {
    return { ...at, verdict: 'cannot-tell', evidence: statements[0].slice(0, 80), why: 'its whole body is one call to something defined elsewhere, which may assert; Tewip will not call this either way' };
  }
  if (unfinished.length > 0) return { ...at, verdict: 'unfinished-expectation', evidence: unfinished[0], why: MEANS['unfinished-expectation'] };
  if (tautology.length > 0) return { ...at, verdict: 'tautology', evidence: tautology[0], why: MEANS.tautology };
  if (body.trim() === '') return { ...at, verdict: 'crash-only', evidence: '(the body is empty)', why: 'the test has no body at all, so nothing can fail it' };
  return { ...at, verdict: 'crash-only', evidence: firstRealLine(body), why: MEANS['crash-only'] };
}

/**
 * The body with the *contents* of strings and template literals blanked, keeping the quotes and
 * everything around them. `expect(x).toBe(1)` still reads as a call; `"expect(true).toBe(true)"` reads
 * as an empty string.
 */
function withoutText(body: string): string {
  let out = body;
  for (const [from, to] of textRanges(body).slice().reverse()) {
    const span = out.slice(from, to + 1);
    if (span.length < 3) continue;
    out = out.slice(0, from + 1) + ' '.repeat(span.length - 2) + out.slice(to);
  }
  return out;
}

/**
 * Everything inside a `try` whose `catch` discards what it caught. An assertion failure is an
 * exception, so a test shaped this way reports success however the code behaves - and a `catch` that
 * asserts, re-throws or fails the test is the legitimate version, which this leaves alone.
 */
function swallowsFailure(body: string, checks: boolean): string {
  if (!checks) return ''; // nothing to swallow; judged as no-assertion instead
  for (const hit of body.matchAll(/catch\s*(\([^)]*\))?\s*\{/g)) {
    const open = body.indexOf('{', hit.index ?? 0);
    const handler = balanced(body, open);
    if (handler === null) continue;
    const meaningful = withoutComments(handler).trim();
    const rescues = checksSomething(handler) || /\b(throw|raise|rethrow|fail|t\s*\.\s*(Error|Fatal)|pytest\s*\.\s*fail)\b/.test(handler);
    if (rescues) continue;
    // A handler that only logs, or does nothing at all, discards the failure.
    if (meaningful === '' || /^(console\s*\.\s*\w+\s*\([^;]*\)\s*;?|print\s*\([^;]*\)\s*;?|pass|;)$/.test(meaningful.replace(/\s+/g, ' ').trim())) {
      return meaningful === '' ? 'catch { }' : meaningful.slice(0, 120);
    }
  }
  return '';
}

/** Functions defined in this file that assert, so a test calling one really is checking something. */
function helpersThatCheck(text: string, language: Language): Set<string> {
  const names = new Set<string>();
  const declarations =
    language === 'python'
      ? /^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm
      : /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:public|private|protected|static|\s)+[\w<>,\[\]]+\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/g;
  for (const hit of text.matchAll(declarations)) {
    const name = hit[1] ?? hit[2] ?? hit[3];
    if (!name) continue;
    const from = (hit.index ?? 0) + hit[0].length;
    const body = language === 'python' ? indentedFrom(text, from) : balanced(text, text.indexOf('{', from - 1));
    if (body && checksSomething(body)) names.add(name);
  }
  return names;
}

/** Python's block after an offset: every line indented further than the line the offset is on. */
function indentedFrom(text: string, from: number): string {
  const lines = text.slice(from).split(String.fromCharCode(10));
  const start = text.slice(0, from).split(String.fromCharCode(10)).pop() ?? '';
  const indent = start.length - start.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    if (line.length - line.trimStart().length <= indent) break;
    body.push(line);
  }
  return body.join(String.fromCharCode(10));
}

/** Names that are calls but not helpers: language and framework machinery. */
const LANGUAGE_NOISE = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'new', 'require', 'import', 'print', 'console', 'log', 'describe', 'beforeEach', 'afterEach', 'it', 'test', 'range', 'len', 'str', 'int', 'super', 'Error', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'JSON', 'Math', 'Map', 'Set']);

const balanced = (text: string, open: number): string | null => {
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

/** Comments cannot assert, and a commented-out check is the classic way a test stops checking. */
function withoutComments(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(String.fromCharCode(10))
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '').replace(/(^|\s)#(?!\{).*$/, ''))
    .join(String.fromCharCode(10));
}

const stripLines = (body: string, lines: string[]): string =>
  body
    .split(String.fromCharCode(10))
    .filter((line) => !lines.some((drop) => line.trim() === drop.trim()))
    .join(String.fromCharCode(10));

/** The first line that does something, for the report to quote. */
function firstRealLine(body: string): string {
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
