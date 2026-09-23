// Writing feature code. Every test here is about the rule that makes it safe: the test comes
// first, it must fail without the code, and anything that cannot be proved is put back byte for
// byte. The model and the test runner are both faked, so what is measured is Tewip's discipline,
// not a model's luck.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LlmClient } from '../llm/client.ts';
import { runBuild } from '../build/build-command.ts';
import { applyEdits, Workspace } from '../build/apply.ts';

const NL = String.fromCharCode(10);
const lines = (...l: string[]) => l.join(NL);

/** A project with a real vitest layout, so the framework is detected the way it is in the wild. */
function project(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-build-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shop', devDependencies: { vitest: '^2.0.0' } }), 'utf8');
  writeFileSync(join(root, 'vitest.config.ts'), 'export default {};', 'utf8');
  const source = join(root, 'src', 'cart.ts');
  writeFileSync(source, lines('export function total(items: number[]): number {', '  return items.reduce((a, b) => a + b, 0);', '}'), 'utf8');
  writeFileSync(join(root, 'test', 'cart.test.ts'), lines("import { total } from '../src/cart.ts';", "it('adds', () => { expect(total([1, 2])).toBe(3); });"), 'utf8');
  return { root, source };
}

/** Answers the build prompts in order. */
function fakeModel(answers: object[]): LlmClient {
  let i = 0;
  return { model: 'fake', complete: async () => JSON.stringify(answers[Math.min(i++, answers.length - 1)]) };
}

const TEST_DRAFT = {
  code: lines("import { totalWithTax } from '../src/cart.ts';", "it('adds tax', () => { expect(totalWithTax([100])).toBe(110); });"),
  checks: 'the total includes ten percent tax',
  failsBecause: 'there is no totalWithTax yet',
};

const CODE = (root: string) => ({
  outcome: 'built',
  why: 'adds totalWithTax, which is the total plus ten percent',
  edits: [{ file: 'src/cart.ts', before: 'export function total(items: number[]): number {', after: lines('export function totalWithTax(items: number[]): number {', '  return total(items) * 1.1;', '}', '', 'export function total(items: number[]): number {') }],
});

/** A runner scripted per call: [the new test, the suite, the new test, the suite, ...]. */
function runner(results: Array<{ passed: boolean; output?: string }>) {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    run: (command: string) => {
      calls.push(command);
      const next = results[Math.min(i++, results.length - 1)];
      return { passed: next.passed, output: next.output ?? (next.passed ? 'ok' : 'FAIL test/x.test.ts > adds tax') };
    },
  };
}

describe('the test comes first', () => {
  it('keeps nothing when the test passes without any new code', async () => {
    const { root } = project();
    const runs = runner([{ passed: true }]);
    const result = await runBuild({ feature: 'add tax', root, model: fakeModel([TEST_DRAFT]), runCommand: runs.run });
    assert.equal(result.status, 'test-passes-already');
    assert.match(result.why, /not testing the feature/);
    assert.deepEqual(readdirNames(join(root, 'test')), ['cart.test.ts'], 'the test Tewip wrote was removed again');
  });

  it('keeps the code when the test fails first, passes after, and nothing else breaks', async () => {
    const { root, source } = project();
    // the new test (fails), the suite baseline, the new test (passes), the suite (clean)
    const runs = runner([{ passed: false }, { passed: true }, { passed: true }, { passed: true }]);
    const result = await runBuild({ feature: 'add tax', root, model: fakeModel([TEST_DRAFT, CODE(root)]), runCommand: runs.run });
    assert.equal(result.status, 'built');
    assert.match(readFileSync(source, 'utf8'), /totalWithTax/);
    assert.ok(result.testFile && existsSync(join(root, result.testFile)), 'the test it wrote is on disk');
    assert.match(result.diff, /\+export function totalWithTax/);
    assert.match(result.log.join(' '), /the test fails today, as it must/);
  });

  it('puts everything back when the test still fails', async () => {
    const { root, source } = project();
    const was = readFileSync(source, 'utf8');
    const runs = runner([{ passed: false }, { passed: true }, { passed: false }, { passed: false }, { passed: false }]);
    const result = await runBuild({ feature: 'add tax', root, repairs: 1, model: fakeModel([TEST_DRAFT, CODE(root), CODE(root)]), runCommand: runs.run });
    assert.equal(result.status, 'still-failing');
    assert.equal(readFileSync(source, 'utf8'), was, 'byte for byte');
    assert.deepEqual(readdirNames(join(root, 'test')), ['cart.test.ts'], 'the test it wrote was removed too');
  });

  it('puts everything back when the feature breaks a test that was passing', async () => {
    const { root, source } = project();
    const was = readFileSync(source, 'utf8');
    const runs = runner([
      { passed: false }, // the new test fails, as it must
      { passed: true }, // the suite is clean to start with
      { passed: true }, // the new test passes
      { passed: false, output: 'FAIL test/cart.test.ts > adds' }, // but this broke
      { passed: true },
      { passed: false, output: 'FAIL test/cart.test.ts > adds' },
    ]);
    const result = await runBuild({ feature: 'add tax', root, repairs: 1, model: fakeModel([TEST_DRAFT, CODE(root), CODE(root)]), runCommand: runs.run });
    assert.equal(result.status, 'broke-others');
    assert.match(result.why, /broke tests that were passing/);
    assert.equal(readFileSync(source, 'utf8'), was);
  });

  it('is not blamed for tests that were already failing', async () => {
    const { root } = project();
    const broken = 'FAIL test/legacy.test.ts > something old';
    const runs = runner([{ passed: false }, { passed: false, output: broken }, { passed: true }, { passed: false, output: broken }]);
    const result = await runBuild({ feature: 'add tax', root, model: fakeModel([TEST_DRAFT, CODE(root)]), runCommand: runs.run });
    assert.equal(result.status, 'built', 'the same test was failing before the feature, so it is not the feature');
    assert.match(result.log.join(' '), /already failing before anything was written/);
  });

  it('says so plainly when the model will not guess', async () => {
    const { root } = project();
    const runs = runner([{ passed: false }, { passed: true }]);
    const cannot = { outcome: 'cannot', why: 'the code that renders the cart is not in this project', edits: [] };
    const result = await runBuild({ feature: 'add tax', root, model: fakeModel([TEST_DRAFT, cannot]), runCommand: runs.run });
    assert.equal(result.status, 'no-code');
    assert.match(result.why, /not in this project/);
    assert.match(result.why, /The test it wrote is a good description of what is missing/);
  });

  it('a dry run leaves nothing on disk but still proves it', async () => {
    const { root, source } = project();
    const was = readFileSync(source, 'utf8');
    const runs = runner([{ passed: false }, { passed: true }, { passed: true }, { passed: true }]);
    const result = await runBuild({ feature: 'add tax', root, dryRun: true, model: fakeModel([TEST_DRAFT, CODE(root)]), runCommand: runs.run });
    assert.equal(result.status, 'built');
    assert.equal(readFileSync(source, 'utf8'), was);
    assert.match(result.diff, /totalWithTax/, 'the patch is still there to apply');
  });
});

describe('what it may write at all', () => {
  it('refuses configuration, lockfiles and anything outside the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-apply-'));
    writeFileSync(join(root, 'package.json'), '{}', 'utf8');
    const workspace = new Workspace(root);
    const { applied, refused } = applyEdits(workspace, root, [
      { file: 'package.json', before: '{}', after: '{"scripts":{"test":"true"}}' },
      { file: '../escape.ts', before: '', after: 'x' },
    ], 50);
    assert.equal(applied.length, 0);
    assert.match(refused.join(' '), /package\.json may not be changed/);
    assert.match(refused.join(' '), /outside the project/);
  });

  it('refuses a change that does not match, and a rewrite dressed up as a feature', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-apply-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), lines('const a = 1;', 'const b = 2;'), 'utf8');
    const workspace = new Workspace(root);
    const { refused } = applyEdits(workspace, root, [
      { file: 'src/a.ts', before: 'const c = 3;', after: 'const c = 4;' },
      { file: 'src/a.ts', before: 'const a = 1;', after: lines(...Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`)) },
    ], 10);
    assert.match(refused[0], /is not in the file/);
    assert.match(refused[1], /rewrite rather than a feature/);
  });

  it('can always put a working tree back, including files it created', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-apply-'));
    mkdirSync(join(root, 'src'));
    const existing = join(root, 'src', 'a.ts');
    writeFileSync(existing, 'const a = 1;', 'utf8');
    const workspace = new Workspace(root);
    workspace.write(existing, 'const a = 2;');
    workspace.write(join(root, 'src', 'new.ts'), 'export const b = 3;');
    workspace.restore();
    assert.equal(readFileSync(existing, 'utf8'), 'const a = 1;');
    assert.equal(existsSync(join(root, 'src', 'new.ts')), false, 'a file it created is removed again');
  });
});

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
