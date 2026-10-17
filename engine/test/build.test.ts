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
import { belongsHere, runBuild } from '../build/build-command.ts';
import { applyEdits, Workspace } from '../build/apply.ts';
import { createHash } from 'node:crypto';
import { mutantsFor } from '../prove/mutants.ts';
import { proveFile } from '../prove/prove.ts';
import type { Framework } from '../quality/frameworks.ts';

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

describe('whether the feature belongs here at all', () => {
  // Found by trying it: a real Apache ticket about a Flink HTTP sink was handed to a URL library,
  // and Tewip built an "HTTP sink" into it - its own test passing, the suite green, every proof
  // rule held. When Tewip writes both the test and the code it can always make a self-consistent
  // pair pass, so something has to ask whether the words mean anything in this repository.
  it('refuses a feature whose words appear nowhere in the project', () => {
    const { root } = project();
    const verdict = belongsHere(root, 'add a Kubernetes operator that reconciles CustomResourceDefinitions and watches namespaces across the cluster', [], []);
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /almost nothing in this project mentions what that describes/);
    assert.match(verdict.why, /would prove nothing/);
  });

  it("allows a feature written in the project as it names things", () => {
    const { root } = project();
    assert.equal(belongsHere(root, 'total should include tax for every item in the cart', [], []).ok, true);
  });

  it('reads what is inside the files, not only their names', () => {
    // "naturalsize" lives inside filesize.py, not in its name; judging by names alone refused a
    // feature that really did belong.
    const root = mkdtempSync(join(tmpdir(), 'tewip-belongs-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'filesize.ts'), 'export function naturalsize(bytes: number) { return bytes; }', 'utf8');
    assert.equal(belongsHere(root, 'naturalsize should accept a separator argument between the number and the unit', [], []).ok, true);
  });

  it('says nothing about a feature described in two words, because there is nothing to judge', () => {
    const { root } = project();
    assert.equal(belongsHere(root, 'add tax', [], []).ok, true);
  });

  it('stops before writing anything, so a wrong repository costs nothing', async () => {
    const { root } = project();
    let called = false;
    const model = { model: 'fake', complete: async () => { called = true; return '{}'; } };
    const result = await runBuild({ feature: 'add a Kubernetes operator that reconciles CustomResourceDefinitions across namespaces', root, model, runCommand: () => ({ passed: false, output: '' }) });
    assert.equal(result.status, 'not-this-project');
    assert.equal(called, false, 'not one model call was spent');
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

// Phase 72: "put back byte for byte" is the riskiest promise in this product, so it was measured
// rather than read. It was not true.
describe('putting a file back exactly as it was', () => {
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const dir = () => mkdtempSync(join(tmpdir(), 'tewip-bytes-'));

  // `// caf<e9>` - one latin-1 byte, which older codebases are full of.
  const LATIN1 = Buffer.from([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6d, 0x6f, 0x64, 0x75, 0x6c, 0x65, 0x3b, 0x0a]);
  const BOM_CRLF = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const a = 1;' + String.fromCharCode(13) + String.fromCharCode(10), 'utf8')]);
  const UTF8 = Buffer.from('export const s = "日本語";' + String.fromCharCode(10), 'utf8');

  for (const [name, bytes] of [['a latin-1 source file', LATIN1], ['a file with a BOM and CRLF', BOM_CRLF], ['plain UTF-8', UTF8]] as Array<[string, Buffer]>) {
    it(`restores ${name} byte for byte`, () => {
      // The workspace held each file as a utf8 **string**, so a byte that is not valid UTF-8 was
      // decoded to U+FFFD and written back as three different bytes: 16 in, 18 out, the character
      // destroyed, and nothing reported. Measured on all three shapes, not reasoned about.
      const root = dir();
      const path = join(root, 'source.js');
      writeFileSync(path, bytes);
      const before = sha(path);

      const workspace = new Workspace(root);
      workspace.write(path, '// Tewip put something else here' + String.fromCharCode(10));
      assert.notEqual(sha(path), before, 'it really did change the file first');
      workspace.restore();

      assert.equal(sha(path), before, 'and put it back with the same bytes');
      assert.equal(readFileSync(path).length, bytes.length);
    });
  }

  it('removes a file it created, rather than leaving an empty one', () => {
    const root = dir();
    const path = join(root, 'new.js');
    const workspace = new Workspace(root);
    workspace.write(path, 'export const x = 1;');
    assert.equal(existsSync(path), true);
    workspace.restore();
    assert.equal(existsSync(path), false);
  });
});

describe('proving a file Tewip could not put back', () => {
  it('refuses to touch it at all, rather than restoring it wrongly', () => {
    // `prove` held the original as a utf8 string and verified its own restore by comparing the
    // **decoded strings** - equally lossy on both sides - so it reported "put back exactly as it
    // was" every time while the bytes had changed. A check that cannot fail proves nothing, which is
    // this project's own rule, inside the function written to enforce it.
    const root = mkdtempSync(join(tmpdir(), 'tewip-prove-bytes-'));
    const path = join(root, 'math.js');
    const bytes = Buffer.concat([Buffer.from([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]), Buffer.from('export const add = (a, b) => a + b;' + String.fromCharCode(10), 'utf8')]);
    writeFileSync(path, bytes);
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');

    const framework = { label: 'node', testDir: root, fileFor: (n: string) => `${n}.test.js` } as unknown as Framework;
    const proof = proveFile(root, 'math.js', ['test/math.test.js'], framework, { limit: 2, budgetSeconds: 30 });

    assert.match(proof.blocked, /not valid UTF-8/);
    assert.match(proof.blocked, /Nothing was written/);
    assert.deepEqual(proof.tried, [], 'not one mutant may be written to a file that cannot be put back');
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before, 'and the file is untouched');
  });

  it('still finds mutants in the same file once it is valid UTF-8', () => {
    assert.ok(mutantsFor('if (a > b) { return 1; }' + String.fromCharCode(10), 4).length > 0);
  });
});
