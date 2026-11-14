// The same text, with Unix and Windows line endings, through every parser that splits it into lines.
//
// `eval/crlf-parity.ts` measured the ten checks the evidence pack runs and found `infra` answering
// differently on a Windows checkout - reporting nothing at all about container capabilities, which
// is the worst way this product can fail, because absence is supposed to mean "nothing found" and
// not "could not read". That harness drives whole checks through `CHECK_RUNNERS`, which is the
// right level for what it covers and cannot reach the rest: there were 40 line-splitting sites
// across 23 files, and ten checks touch perhaps half of them.
//
// `vouch` is the gap that matters. It is the flagship command - "could these tests ever fail?" -
// it reads a stranger's test files line by line, and it has 13 splitting sites across 5 files. It
// does not appear in the other harness at all, because answering its question means running a real
// test suite rather than reading a tree.
//
// So this works one level down: each parser is a pure function from text, called twice on the same
// text with the two endings, and the answers compared. That is exactly the level the bug lives at,
// it needs no fixture project, and it runs in milliseconds.
import { checksSomething, tautologies, unfinishedExpectations } from '../engine/vouch/assertions.ts';
import { lineAt, looksLikeTests, testsIn, textRanges } from '../engine/vouch/tests-in.ts';
import { firstRealLine, withoutComments } from '../engine/vouch/text.ts';
import { readLcov } from '../engine/coverage/read-coverage.ts';
import { candidateMutants } from '../engine/prove/mutants.ts';
import { check as checkStandards, readStandard } from '../engine/standards/standards.ts';
import { flows } from '../engine/taint/flow.ts';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** A parser, and text with something in it for that parser to find. */
interface Reader {
  name: string;
  /** The file this parser lives in, so a difference points somewhere. */
  from: string;
  lines: string[];
  /** Called with the text joined by the ending under test. Must return something comparable. */
  read: (text: string) => unknown;
  /**
   * True for a parser that hands back a slice of the text it was given.
   *
   * `testsIn` returns each test's body, so with CRLF input the body contains CRLF - the name, the
   * line number and the verdict are identical, and only the quoted text differs. That is the
   * parser doing its job, not reading an ending as content, so its answer is compared with endings
   * normalised. Named here rather than quietly skipped: an exemption nobody can see is how a
   * harness stops measuring, and both callers in `vouch` normalise before this is reached anyway.
   */
  carriesInputText?: boolean;
}

const JS_TEST = [
  "import { test, expect } from '@playwright/test';",
  '',
  '// a comment that mentions expect(1).toBe(1)',
  "test('adds up', async () => {",
  '  const total = add(2, 2);',
  '  expect(total).toBe(4);',
  '});',
  '',
  "test('forgets to finish', async () => {",
  '  expect(add(1, 1));',
  '});',
  '',
  "test('does nothing at all', async () => {",
  '  const page = await open();',
  '});',
  '',
  "test('checks itself', async () => {",
  '  expect(true).toBe(true);',
  '});',
];

const SOURCE = [
  'export function add(a, b) {',
  '  if (a > 0 && b > 0) {',
  '    return a + b;',
  '  }',
  '  return 0;',
  '}',
];

const TAINTED = [
  "import { execSync } from 'node:child_process';",
  'export function list(req) {',
  '  const dir = req.query.dir;',
  '  return execSync("ls " + dir);',
  '}',
];

// The real syntax, which is prose rather than YAML values: `forbid: /pattern/ in <where> because
// <reason>`. `forbid` is deliberately not the last line - that is the shape that lost every rule
// silently on Windows, because the optional carriage return in the front-matter pattern rescued
// only the last line.
const STANDARD = [
  '---',
  'name: house style',
  'forbid: /console\.log/ in src/ because logs hide assertions',
  'applies-to: src/',
  '---',
  '',
  '# No console.log in shipped code',
  '',
  'Use the logger instead.',
];

const LCOV = ['TN:', 'SF:src/add.js', 'DA:1,1', 'DA:2,1', 'DA:3,0', 'LF:3', 'LH:2', 'end_of_record'];

const READERS: Reader[] = [
  { name: 'vouch: testsIn', from: 'engine/vouch/tests-in.ts', lines: JS_TEST, read: (t) => testsIn('js', t), carriesInputText: true },
  { name: 'vouch: looksLikeTests', from: 'engine/vouch/tests-in.ts', lines: JS_TEST, read: (t) => looksLikeTests('a.spec.js', t) },
  { name: 'vouch: textRanges', from: 'engine/vouch/tests-in.ts', lines: JS_TEST, read: (t) => textRanges(t, 'js').length },
  {
    // The line a finding points at. An off-by-one here is what Kubernetes had: the finding is real
    // and the line number sends the reader to the line above it.
    name: 'vouch: lineAt (last line)',
    from: 'engine/vouch/tests-in.ts',
    lines: JS_TEST,
    read: (t) => lineAt(t, t.lastIndexOf('expect(true)')),
  },
  // Returns the whole file with comments blanked out, so it quotes its input by definition.
  { name: 'vouch: withoutComments', from: 'engine/vouch/text.ts', lines: JS_TEST, read: (t) => withoutComments(t), carriesInputText: true },
  { name: 'vouch: firstRealLine', from: 'engine/vouch/text.ts', lines: JS_TEST, read: (t) => firstRealLine(t) },
  { name: 'vouch: checksSomething', from: 'engine/vouch/assertions.ts', lines: JS_TEST, read: (t) => checksSomething(t) },
  { name: 'vouch: unfinishedExpectations', from: 'engine/vouch/assertions.ts', lines: JS_TEST, read: (t) => unfinishedExpectations(t) },
  { name: 'vouch: tautologies', from: 'engine/vouch/assertions.ts', lines: JS_TEST, read: (t) => tautologies(t) },
  { name: 'prove: candidateMutants', from: 'engine/prove/mutants.ts', lines: SOURCE, read: (t) => candidateMutants(t) },
  { name: 'taint: flows', from: 'engine/taint/flow.ts', lines: TAINTED, read: (t) => flows('src/list.js', t) },
  { name: 'standards: readStandard', from: 'engine/standards/standards.ts', lines: STANDARD, read: (t) => readStandard('.tewip/standards.md', t) },
  {
    name: 'standards: check',
    from: 'engine/standards/standards.ts',
    lines: STANDARD,
    read: (t) => checkStandards([readStandard('.tewip/standards.md', t)], 'src/a.js', `console.log("x");${NL}`),
  },
  { name: 'coverage: readLcov', from: 'engine/coverage/read-coverage.ts', lines: LCOV, read: (t) => readLcov(t) },
];

export interface Reading {
  name: string;
  from: string;
  lf: string;
  crlf: string;
  agrees: boolean;
  /** Whether the parser found anything at all. One that finds nothing agrees for free. */
  empty: boolean;
  /** Whether endings inside quoted input text were ignored in the comparison. */
  quotesInput: boolean;
}

/** `JSON.stringify` of an answer, with `undefined` and a thrown error both made comparable. */
function answer(read: (t: string) => unknown, text: string): string {
  try {
    return JSON.stringify(read(text) ?? null);
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const EMPTY = new Set(['null', '[]', '{}', 'false', '0', '""', 'undefined']);

export function measure(): Reading[] {
  return READERS.map((r) => {
    const lf = answer(r.read, r.lines.join(NL) + NL);
    const crlf = answer(r.read, r.lines.join(CR + NL) + CR + NL);
    // For a parser that quotes its input, the comparison ignores the endings inside the quoted
    // text and nothing else. See `carriesInputText`.
    // The answers are JSON, so a newline inside quoted text appears as the two characters
    // \\r\\n. Only those are collapsed, and only for a parser that quotes its input.
    const strip = (text: string) => (r.carriesInputText ? text.split('\\r\\n').join('\\n') : text);
    return { name: r.name, from: r.from, lf, crlf, agrees: strip(lf) === strip(crlf), empty: EMPTY.has(lf), quotesInput: r.carriesInputText === true };
  });
}

function report(): void {
  const all = measure();
  const differ = all.filter((r) => !r.agrees);
  const empty = all.filter((r) => r.empty);
  const trim = (s: string) => (s.length > 220 ? `${s.slice(0, 220)}…` : s);

  process.stdout.write(
    [
      '# the same text, with Unix and Windows line endings, through every parser that splits it',
      '',
      `${all.length} parsers, each called twice on the same text: once joined with LF, once with CRLF.`,
      '',
      `Parsers that agree:            ${all.length - differ.length} of ${all.length}`,
      `Parsers that answer differently: ${differ.length}`,
      '',
      '## Parsers that read a line ending as content',
      '',
      ...(differ.length === 0
        ? ['None.']
        : differ.flatMap((r) => [`### \`${r.name}\`  (${r.from})`, '', `- with LF:   ${trim(r.lf)}`, `- with CRLF: ${trim(r.crlf)}`, ''])),
      '',
      '## Parsers that found nothing, so prove nothing here',
      '',
      ...(empty.length === 0 ? ['None - every parser found something in its fixture.'] : empty.map((r) => `- \`${r.name}\` returned ${r.lf}`)),
      '',
      '---',
      '',
      'Why one level down from eval/crlf-parity.ts: that harness drives whole checks through',
      'CHECK_RUNNERS, which cannot reach `vouch` at all - answering its question means running a real',
      "test suite. `vouch` is the flagship command, it reads a stranger's test files line by line, and",
      'it has 13 splitting sites across 5 files. This is the level the bug lives at.',
      '',
      'What this does not settle: a parser can agree on this fixture and differ on text that exercises',
      'a branch the fixture does not reach. Agreement here is agreement on what it was shown.',
      '',
    ].join(NL),
  );
  if (differ.length > 0 || empty.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
