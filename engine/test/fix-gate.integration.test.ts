// The safety gates, proved by running tests rather than by reading proposals.
//
// Everything else measured about `tewip fix` so far has compared what it *suggests* with what a
// developer did. That leaves the most important claim untested: a fix is kept only when re-running
// the test actually proves it, three times in a row for a race and twice for test data, and
// otherwise the file goes back exactly as it was. Those are the promises that make this safe to
// install, so here they are exercised end to end - real files on disk, a real `node --test` per
// attempt, real exit codes.
//
// The project under test is a throwaway one created here, which is what makes this runnable in CI
// in a second or two. What is real is the machinery: the same attemptWaitFix and attemptDataFix a
// user's project gets, with a verify that truly runs their test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attemptWaitFix } from '../autofix/fix-wait.ts';
import { attemptDataFix } from '../autofix/fix-data.ts';
import type { AutofixDeps } from '../autofix/autofix.ts';
import type { TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);

/**
 * A child `node --test` inherits NODE_TEST_CONTEXT from the runner that spawns it and then reports
 * as a subtest of it rather than by its own exit code - so a failing test looked like a passing one
 * and the collision this file relies on never appeared. The child gets a clean environment.
 */
const CLEAN = (() => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
})();
const file = (...lines: string[]) => lines.join(NL) + NL;

/** Runs one test file for real and reports whether it passed, the way CI would. */
function runner(root: string): AutofixDeps {
  return {
    allowedRoot: root,
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
    verify: async (specFile) => {
      try {
        execFileSync(process.execPath, ['--test', specFile], { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 60_000, env: CLEAN });
        return { passed: true, detail: 'the test ran and passed' };
      } catch (error) {
        return { passed: false, detail: String((error as { stdout?: string }).stdout ?? '').split(NL).slice(-3).join(' ').slice(0, 120) };
      }
    },
    loadSnapshot: () => null,
  };
}

const record = (testId: string, specFile: string, line: number, message: string): TriageRecord =>
  ({
    schemaVersion: 1, testId, file: specFile, status: 'failed', errorMessage: message,
    errorStack: `Error: ${message}${NL}    at ${specFile}:${line}:5`,
    duration: 10, retry: 0, attachments: [], runId: 'r1', gitSha: '', timestamp: new Date().toISOString(),
  }) as unknown as TriageRecord;

const TIMING = { category: 'TIMING', confidence: 0.8, source: 'rules', evidence: [] } as never;
const TEST_DATA = { category: 'TEST_DATA', confidence: 0.85, source: 'rules', evidence: [] } as never;
const waitAction = { kind: 'fix-wait', owner: 'agent', autonomous: true, summary: '', reason: '' } as never;
const dataAction = { kind: 'fix-precondition', owner: 'agent', autonomous: true, summary: '', reason: '' } as never;

const project = (): string => mkdtempSync(join(tmpdir(), 'tewip-gate-'));

describe('the wait fix, gated by running the test', () => {
  it('keeps the change only after the test really passes three times', async () => {
    const root = project();
    const spec = join(root, 'ready.test.js');
    writeFileSync(
      spec,
      file(
        "const { test } = require('node:test');",
        "const assert = require('node:assert');",
        "test('the value arrives', async () => {",
        '  let value = null;',
        '  setTimeout(() => { value = 42; }, 5);',
        '  await new Promise(resolve => setTimeout(resolve, 300));',
        '  await waitFor(() => value !== null);',
        '  assert.equal(value, 42);',
        '});',
        'async function waitFor(check) {',
        '  for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 10));',
        '}',
      ),
      'utf8',
    );
    const before = readFileSync(spec, 'utf8');

    const fix = await attemptWaitFix(
      { record: record('the value arrives', spec, 7, 'TimeoutError: timed out'), diagnosis: TIMING, action: waitAction, specFile: spec, framework: 'other' },
      runner(root),
    );

    assert.equal(fix.status, 'fixed', `expected a kept fix, got ${fix.status}: ${fix.log.join(' | ')}`);
    assert.equal(fix.attempts[0].passes, 3, 'three real runs, not one');
    const after = readFileSync(spec, 'utf8');
    assert.ok(!after.includes('resolve, 300'), 'the fixed wait is gone from the file on disk');
    assert.ok(after.includes('assert.equal(value, 42)'), 'the check the test exists for is untouched');
    // And the test still passes, which is the only thing that made the change acceptable.
    execFileSync(process.execPath, ['--test', spec], { cwd: root, stdio: 'pipe', env: CLEAN });
    assert.notEqual(before, after);
  });

  it('puts the file back exactly as it was when the test does not pass', async () => {
    const root = project();
    const spec = join(root, 'racy.test.js');
    // Here the wait is load-bearing: the value only arrives after 200ms, and nothing else waits.
    const source = file(
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('needs the wait', async () => {",
      '  let value = null;',
      '  setTimeout(() => { value = 7; }, 200);',
      '  await new Promise(resolve => setTimeout(resolve, 400));',
      '  assert.equal(value, 7);',
      '});',
    );
    writeFileSync(spec, source, 'utf8');

    const fix = await attemptWaitFix(
      { record: record('needs the wait', spec, 7, 'AssertionError'), diagnosis: TIMING, action: waitAction, specFile: spec, framework: 'other' },
      runner(root),
    );

    assert.notEqual(fix.status, 'fixed', 'a change that breaks the test must never be kept');
    assert.equal(readFileSync(spec, 'utf8'), source, 'the file is byte-for-byte what it was');
    execFileSync(process.execPath, ['--test', spec], { cwd: root, stdio: 'pipe', env: CLEAN });
  });
});

describe('the test-data fix, gated by running the test twice', () => {
  it('proves uniqueness by two passes where the second used to fail', async () => {
    const root = project();
    mkdirSync(join(root, 'store'), { recursive: true });
    const spec = join(root, 'signup.test.js');
    // A real collision: the test creates a record keyed by a literal, so a second run hits the one
    // the first run left behind. That is exactly why this fix runs the test twice.
    writeFileSync(
      spec,
      file(
        "const { test } = require('node:test');",
        "const assert = require('node:assert');",
        "const { writeFileSync, existsSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "test('creates an account', () => {",
        "  const email = 'sam@example.com';",
        "  const path = join(__dirname, 'store', email + '.json');",
        "  assert.ok(!existsSync(path), 'duplicate key value violates unique constraint');",
        "  writeFileSync(path, '{}');",
        '});',
      ),
      'utf8',
    );

    // It passes once and fails the second time, which is the failure a person would bring to Tewip.
    execFileSync(process.execPath, ['--test', spec], { cwd: root, stdio: 'pipe', env: CLEAN });
    assert.throws(() => execFileSync(process.execPath, ['--test', spec], { cwd: root, stdio: 'pipe', env: CLEAN }), 'the collision is real');

    const fix = await attemptDataFix(
      {
        record: record('creates an account', spec, 8, 'duplicate key value violates unique constraint "users_email"\nKey (email)=(sam@example.com) already exists.'),
        diagnosis: TEST_DATA,
        action: dataAction,
        specFile: spec,
      },
      runner(root),
    );

    assert.equal(fix.status, 'fixed', `expected a kept fix, got ${fix.status}: ${fix.log.join(' | ')}`);
    assert.equal(fix.attempts.at(-1)?.passes, 2, 'two runs in a row, which is what proves the value differs each time');
    assert.match(readFileSync(spec, 'utf8'), /Date\.now\(\)/, 'the literal is now generated');
    // The property the fix exists for: it can be run again and again.
    execFileSync(process.execPath, ['--test', spec], { cwd: root, stdio: 'pipe', env: CLEAN });
    execFileSync(process.execPath, ['--test', spec], { cwd: root, stdio: 'pipe', env: CLEAN });
  });
});
