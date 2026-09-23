// Phase 12: the one place Tewip may change application code. Every test here is about a refusal or
// a proof - what it will not touch, and what it must show before a change survives. The model and
// the test runner are both faked, so what is tested is Tewip's own discipline, not a model's answer.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LlmClient } from '../llm/client.ts';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { PlannedAction } from '../decide.ts';
import { codeTarget, isTestFile, mayChange, stackFrames } from '../autofix/code-target.ts';
import { attemptCodeFix, changedLines, changeDiff, MAX_CHANGED_LINES } from '../autofix/code-fix.ts';

const SOURCE = ['export function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.price;', '  return sum;', '}', ''].join('\n');

/** A project on disk: one source file, one test file. */
function project(): { root: string; source: string; test: string } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-fix-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  const source = join(root, 'src', 'cart.js');
  const test = join(root, 'test', 'cart.test.js');
  writeFileSync(source, SOURCE, 'utf8');
  writeFileSync(test, 'test("adds tax", () => {});\n', 'utf8');
  return { root, source, test };
}

const record = (stack: string): TriageRecord =>
  ({ schemaVersion: 1, testId: 'cart > adds tax', file: 'test/cart.test.js', status: 'failed', errorMessage: 'expected 110 received 100', errorStack: stack, duration: 5, retry: 0, attachments: [], runId: 'r1', gitSha: '', timestamp: new Date().toISOString() }) as TriageRecord;

const REAL_BUG: Diagnosis = { category: 'REAL_BUG', confidence: 0.92 } as Diagnosis;
const FILE_BUG: PlannedAction = { kind: 'file-bug' } as PlannedAction;

/** A model that answers with the changes given, in order. */
function fakeModel(answers: object[]): LlmClient {
  let i = 0;
  return { model: 'fake', complete: async () => JSON.stringify(answers[Math.min(i++, answers.length - 1)]) };
}

const NL = String.fromCharCode(10);
const FIX = { fault: 'bug', why: 'tax was never added to the total', before: '  return sum;', after: '  return sum * 1.1;' };

/** Deps that read and write real files, with scripted run results. */
function deps(root: string, model: LlmClient, test: boolean[], suite: boolean[]) {
  let t = 0;
  let s = 0;
  return {
    root,
    readFile: (p: string) => readFileSync(p, 'utf8'),
    writeFile: (p: string, c: string) => writeFileSync(p, c, 'utf8'),
    runTest: async () => ({ passed: test[Math.min(t++, test.length - 1)], output: 'test output' }),
    runSuite: async () => ({ passed: suite[Math.min(s++, suite.length - 1)], output: 'suite output' }),
    model,
  };
}

describe('what may be changed at all', () => {
  it('reads the files a stack names, in Node, Python and .NET form', () => {
    const { root, source, test } = project();
    const stack = [`at total (${source}:3:24)`, `File "${source}", line 3, in total`, `at Object.<anonymous> (${test}:1:1)`].join('\n');
    const frames = stackFrames(stack, root);
    assert.ok(frames.some((f) => f.file === source && f.line === 3));
    assert.ok(frames.some((f) => f.file === test));
    assert.deepEqual(stackFrames('at total (/somewhere/else/x.js:1:1)', root), [], 'a file outside the project is not a frame Tewip may use');
  });

  it('knows a test from the code under test', () => {
    assert.ok(isTestFile('test/cart.test.js'));
    assert.ok(isTestFile('tests/test_cart.py'));
    assert.ok(isTestFile('src/CartTest.java'));
    assert.ok(!isTestFile('src/cart.js'));
  });

  it('refuses the files where a passing test would prove nothing', () => {
    assert.equal(mayChange('src/cart.js').allowed, true);
    assert.equal(mayChange('test/cart.test.js').allowed, false, 'editing the test is not a fix');
    assert.equal(mayChange('package.json').allowed, false);
    assert.equal(mayChange('.github/workflows/ci.yml').allowed, false);
    assert.equal(mayChange('.env').allowed, false);
    assert.equal(mayChange('pnpm-lock.yaml').allowed, false);
    assert.equal(mayChange('db/migrations/001_users.sql').allowed, false);
    assert.equal(mayChange('node_modules/lib/index.js').allowed, false);
  });


  it('prefers the file that defines the function the failing test is about', () => {
    // From the real measurement: a test named "parseQuery: ..." must lead to src/query.ts, not to
    // the file of utilities that the test also happens to import a dozen names from.
    const root = mkdtempSync(join(tmpdir(), 'tewip-target-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    const file = (dir: string, name: string, lines: string[]) => {
      const full = join(root, dir, name);
      writeFileSync(full, lines.join(NL), 'utf8');
      return full;
    };
    file('src', 'index.ts', ['export * from "./utils.ts";', 'export * from "./query.ts";']);
    file('src', 'utils.ts', ['export function withBase(a: string) {', '  return a;', '}', 'export function joinURL(a: string) {', '  return a;', '}']);
    file('src', 'query.ts', ['export function parseQuery(s: string) {', '  return {};', '}']);
    const source = ['import { parseQuery, withBase, joinURL } from "../src";', 'describe("parseQuery", () => {});'].join(NL);
    const testFile = file('test', 'query.test.ts', [source]);
    const { target } = codeTarget('at Object.<anonymous> (test/query.test.ts:2:1)', root, { file: testFile, source }, 'query.test.ts > parseQuery > keeps a null prototype');
    assert.equal(target?.file, join(root, 'src', 'query.ts'));
  });

  it('stops when the runner never ran the test at all', async () => {
    const { root, source } = project();
    const runnerBroke = { ...deps(root, fakeModel([FIX]), [false], [true]), runTest: async () => ({ passed: false, output: 'Error: Failed to load url basic' }) };
    const result = await attemptCodeFix({ record: record(`at total (${source}:3:24)`), diagnosis: REAL_BUG, action: FILE_BUG, testSource: '' }, runnerBroke);
    assert.equal(result.status, 'test-never-ran');
  });

  it('says it has nothing to fix when the stack only names tests', () => {
    const { root, test } = project();
    const { target, why } = codeTarget(`at Object.<anonymous> (${test}:1:1)`, root);
    assert.equal(target, null);
    assert.match(why, /may not change/);
  });
});

describe('proving a change before offering it', () => {
  const input = (root: string, source: string) => ({ record: record(`at total (${source}:3:24)`), diagnosis: REAL_BUG, action: FILE_BUG, testSource: 'test("adds tax", () => {});' });

  it('keeps a change only when the test passes and the suite still passes, and puts the file back', async () => {
    const { root, source } = project();
    const result = await attemptCodeFix(input(root, source), deps(root, fakeModel([FIX]), [false, true], [true]));
    assert.equal(result.status, 'fixed');
    assert.equal(result.applied, false, 'a proved change is offered as a patch, not left in the branch');
    assert.match(result.diff ?? '', /-\s+return sum;/);
    assert.match(result.diff ?? '', /\+\s+return sum \* 1\.1;/);
    assert.equal(readFileSync(source, 'utf8'), SOURCE, 'the file is exactly as it was');
  });

  it('throws the change away when it makes this test pass by breaking others', async () => {
    const { root, source } = project();
    const result = await attemptCodeFix(input(root, source), deps(root, fakeModel([FIX]), [false, true], [false]));
    assert.equal(result.status, 'broke-others');
    assert.equal(readFileSync(source, 'utf8'), SOURCE);
  });

  it('will not touch code for a failure that is not a confident real bug', async () => {
    const { root, source } = project();
    const flaky = { ...input(root, source), diagnosis: { category: 'TIMING', confidence: 0.9 } as Diagnosis };
    const result = await attemptCodeFix(flaky, deps(root, fakeModel([FIX]), [false, true], [true]));
    assert.equal(result.status, 'not-eligible');
    const unsure = { ...input(root, source), diagnosis: { category: 'REAL_BUG', confidence: 0.6 } as Diagnosis };
    assert.equal((await attemptCodeFix(unsure, deps(root, fakeModel([FIX]), [false, true], [true]))).status, 'not-eligible');
  });

  it('stops when the test passes as the code is, because a pass afterwards would prove nothing', async () => {
    const { root, source } = project();
    const result = await attemptCodeFix(input(root, source), deps(root, fakeModel([FIX]), [true], [true]));
    assert.equal(result.status, 'test-does-not-fail');
  });

  it('accepts "I cannot see it" from the model instead of a guess', async () => {
    const { root, source } = project();
    const declined = { fault: 'test', why: 'the code looks right; the test expects tax the app never applies', before: '', after: '' };
    const result = await attemptCodeFix(input(root, source), deps(root, fakeModel([declined]), [false], [true]));
    assert.equal(result.status, 'model-declined');
    assert.match(result.why ?? '', /the code looks right/);
  });

  it('refuses a change that does not match the file exactly once', async () => {
    const { root, source } = project();
    const wrong = { ...FIX, before: '  let sum = 0;\n  let sum = 0;' };
    const result = await attemptCodeFix(input(root, source), deps(root, fakeModel([wrong]), [false, true], [true]));
    assert.equal(result.status, 'change-not-found');
  });

  it('refuses a rewrite dressed up as a fix', async () => {
    const { root, source } = project();
    const rewrite = { ...FIX, before: SOURCE.trim(), after: Array.from({ length: MAX_CHANGED_LINES + 5 }, (_, i) => `// line ${i}`).join('\n') };
    const result = await attemptCodeFix(input(root, source), deps(root, fakeModel([rewrite]), [false, true], [true]));
    assert.equal(result.status, 'change-too-large');
  });

  it('counts a change by the lines it really touches', () => {
    assert.equal(changedLines('a\nb\nc', 'a\nb\nc'), 0);
    assert.equal(changedLines('a\nb\nc', 'a\nB\nc'), 2);
    assert.match(changeDiff('src/cart.js', 'a\nb\nc', 'a\nB\nc'), /--- a\/src\/cart\.js/);
  });
});
