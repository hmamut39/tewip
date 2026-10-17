// Phase 23 proved by running it: real files on disk, a real test runner, real mutants.
//
// The claims this file exists to check are the ones a reader would otherwise have to take on faith.
// That a change the tests do not check is reported as unnoticed. That a change they do check is
// reported as caught, naming the test. That the file is put back **byte for byte**, including its line
// endings, because this is the only command in Tewip that writes to source the developer did not ask
// it to touch. And that it refuses to say anything at all when the suite does not pass to begin with,
// or when nothing imports the file - a confident answer in either case would be a lie.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Framework } from '../quality/frameworks.ts';
import { proveFile } from '../prove/prove.ts';
import { proveChanged, provedChangeLines } from '../prove/changed.ts';
import { aroundTheChange, renderProof } from '../prove/prove-command.ts';
import { candidateMutants, mutantsFor } from '../prove/mutants.ts';

const NL = String.fromCharCode(10);
const file = (...lines: string[]) => lines.join(NL) + NL;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Node's own runner, pointed at one file, exactly as the real framework object would be. */
const nodeRunner = (root: string): Framework => ({
  id: 'node',
  label: "Node's own test runner",
  browser: false,
  cwd: root,
  testDir: join(root, 'tests'),
  example: null,
  fileFor: (id) => `${id}.test.js`,
  command: (f) => `node --test ${JSON.stringify(f)}`,
  suite: 'node --test',
});

const SOURCE = file(
  'function discountFor(total, isMember) {',
  '  if (total >= 100 && isMember) return 0.2;',
  '  return 0;',
  '}',
  '',
  'function canCheckout(cart) {',
  '  if (!cart.items.length) return false;',
  '  return true;',
  '}',
  '',
  'module.exports = { discountFor, canCheckout };',
);

/**
 * One test that really checks the discount **at its boundary**, and one that calls canCheckout without
 * checking anything.
 *
 * The boundary matters, and getting it wrong here was instructive: the first version of this fixture
 * asserted `discountFor(150, true)`, and then complained that Tewip missed the change from `>= 100` to
 * `> 100`. It had not missed anything - 150 is over 100 either way, so the change really is invisible
 * to that test. A suite that never tests the edge cannot notice the edge moving, which is the whole
 * point of the command.
 */
const TESTS = file(
  "const assert = require('node:assert/strict');",
  "const { test } = require('node:test');",
  "const { discountFor, canCheckout } = require('../src/shop');",
  '',
  "test('a member gets the discount exactly at the threshold', () => {",
  '  assert.equal(discountFor(100, true), 0.2);',
  '});',
  '',
  "test('checkout runs', () => {",
  '  canCheckout({ items: [1] });',
  '});',
);

function project(source = SOURCE, tests = TESTS): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-prove-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'src', 'shop.js'), source, 'utf8');
  writeFileSync(join(root, 'tests', 'shop.test.js'), tests, 'utf8');
  return root;
}

describe('proving what the tests would not catch', () => {
  it('reports a change the tests do not check, and names the test that catches one they do', () => {
    const root = project();
    const proof = proveFile(root, 'src/shop.js', ['tests/shop.test.js'], nodeRunner(root), { limit: 6, runSeconds: 60 });
    assert.equal(proof.blocked, '', proof.blocked);
    assert.ok(proof.tried.length >= 2, `only ${proof.tried.length} change(s) were tried`);

    const noticed = proof.tried.filter((t) => t.fate === 'noticed');
    const unnoticed = proof.tried.filter((t) => t.fate === 'unnoticed');
    assert.ok(noticed.length > 0, 'the discount is asserted, so at least one change must be caught');
    assert.equal(noticed[0].noticedBy, 'tests/shop.test.js');
    // `canCheckout` is called and never checked, so flipping what it returns goes unnoticed.
    assert.ok(
      unnoticed.some((t) => /return (true|false)/.test(t.mutant.was)),
      `a test that calls canCheckout without checking it should miss a flipped return, got: ${unnoticed.map((t) => t.mutant.was).join(' | ')}`,
    );
  });

  it('puts the file back byte for byte, line endings and all', () => {
    // Windows line endings are the case a careless "write the lines back" would silently change.
    const root = project(SOURCE.split(NL).join(String.fromCharCode(13) + NL));
    const path = join(root, 'src', 'shop.js');
    const before = sha(path);
    proveFile(root, 'src/shop.js', ['tests/shop.test.js'], nodeRunner(root), { limit: 4, runSeconds: 60 });
    assert.equal(sha(path), before, 'the source was not restored exactly as it was');
    assert.ok(readFileSync(path, 'utf8').includes(String.fromCharCode(13) + NL), 'the line endings were changed');
  });

  it('says nothing when no covering test passes as it is', () => {
    const broken = TESTS.replace('0.2);', '0.5);');
    const root = project(SOURCE, broken);
    const proof = proveFile(root, 'src/shop.js', ['tests/shop.test.js'], nodeRunner(root), { limit: 2, runSeconds: 60 });
    assert.deepEqual(proof.tried, [], 'nothing may be mutated while every covering test is red');
    assert.match(proof.blocked, /pass as they are/);
    assert.deepEqual(proof.setAside.map((a) => a.test), ['tests/shop.test.js']);
  });

  it('sets a failing test aside and answers with the ones that pass', () => {
    // python-humanize taught this: six test files cover one module and one of them needs a plugin
    // that is not installed. Refusing the whole question over that told the developer nothing.
    const root = project();
    writeFileSync(join(root, 'tests', 'broken.test.js'), file("const { test } = require('node:test');", "const { discountFor } = require('../src/shop');", "test('wrong on purpose', () => { if (discountFor(100, true) !== 0.9) throw new Error('no'); });"), 'utf8');
    const proof = proveFile(root, 'src/shop.js', ['tests/broken.test.js', 'tests/shop.test.js'], nodeRunner(root), { limit: 3, runSeconds: 60 });
    assert.deepEqual(proof.setAside.map((a) => a.test), ['tests/broken.test.js']);
    assert.deepEqual(proof.covering, ['tests/shop.test.js'], 'only the passing test may judge a mutant');
    assert.ok(proof.tried.length > 0, 'the answer still comes from the test that does pass');
    // A test that fails before anything changed fails afterwards too, and must never be credited.
    assert.ok(proof.tried.every((t) => t.noticedBy !== 'tests/broken.test.js'), 'a red test cannot be said to have caught anything');
  });

  it('refuses to report survivors when the tests do not load the file it edited', () => {
    // The trap that produced a completely false report on its first Python project: `import humanize`
    // resolved to another checkout, so the edits changed nothing the tests ran, and every mutant
    // "survived". The control breaks the file outright and requires a covering test to notice.
    const root = project();
    const tests = readFileSync(join(root, 'tests', 'shop.test.js'), 'utf8').replace("require('../src/shop')", "require('../src/copy-of-shop')");
    writeFileSync(join(root, 'src', 'copy-of-shop.js'), SOURCE, 'utf8');
    writeFileSync(join(root, 'tests', 'shop.test.js'), tests, 'utf8');
    const proof = proveFile(root, 'src/shop.js', ['tests/shop.test.js'], nodeRunner(root), { limit: 3, runSeconds: 60 });
    assert.deepEqual(proof.tried, []);
    assert.match(proof.blocked, /not loading the file that was edited/);
  });

  it('treats "nothing imports this file" as the finding, not as a clean result', () => {
    const root = project();
    const proof = proveFile(root, 'src/shop.js', [], nodeRunner(root), {});
    assert.deepEqual(proof.tried, []);
    assert.match(proof.blocked, /no test imports this file/);
    assert.match(proof.blocked, /That is the finding/);
  });

  it('stops when the time budget is spent and says how many were left', () => {
    const root = project();
    const proof = proveFile(root, 'src/shop.js', ['tests/shop.test.js'], nodeRunner(root), { limit: 6, budgetSeconds: 0, runSeconds: 60 });
    assert.ok(proof.notTried > 0, 'a spent budget has to be reported, not hidden');
  });
});

describe('proving what a pull request changed, inside CI', () => {
  it('reports the changes that slipped past, and stays silent when none did', () => {
    const root = project();
    const proved = proveChanged(root, ['src/shop.js', 'tests/shop.test.js', 'README.md'], { limit: 4, budgetSeconds: 120 });
    assert.equal(proved.skipped, '');
    assert.equal(proved.proofs.length, 1, 'the test file and the readme are not source to prove');
    const lines = provedChangeLines(proved).join(NL);
    assert.match(lines, /would have slipped past the tests/);
    assert.match(lines, /src\/shop\.js:/);
    assert.match(lines, /put back exactly as it was/);

    // A file whose every change is caught produces no section at all.
    const quiet = { proofs: [{ file: 'src/shop.js', covering: [], tried: [], blocked: '', setAside: [], notTried: 0, found: 0, seconds: 1 }], unnoticed: 0, notReached: [], skipped: '' };
    assert.deepEqual(provedChangeLines(quiet), [], 'a section that always appears is a section nobody reads');
  });

  it('says what it did not reach rather than implying those files were clean', () => {
    const root = project();
    const proved = proveChanged(root, ['src/shop.js', 'src/other.js'], { maxFiles: 1, limit: 2, budgetSeconds: 120 });
    // src/other.js does not exist here, so the real check is the cap itself.
    assert.ok(proved.proofs.length <= 1);
    const capped = proveChanged(root, ['src/shop.js'], { maxFiles: 0, limit: 2, budgetSeconds: 120 });
    assert.deepEqual(capped.notReached, ['src/shop.js']);
    assert.deepEqual(capped.proofs, []);
  });

  it('says so plainly when a change touches nothing it could prove', () => {
    const root = project();
    const proved = proveChanged(root, ['README.md', 'tests/shop.test.js'], {});
    assert.match(proved.skipped, /no source file that could be proved/);
    assert.deepEqual(provedChangeLines(proved), []);
  });
});

// Phase 58: `--limit` samples the file, and for a long time the report did not say so.
describe('a clean answer that covers part of a file', () => {
  const proof = (over: Partial<Parameters<typeof renderProof>[0][0]>) => ({
    file: 'src/shop.js',
    covering: ['tests/shop.test.js'],
    tried: [],
    blocked: '',
    setAside: [],
    notTried: 0,
    found: 0,
    seconds: 1,
    ...over,
  });
  const caught = (line: number) => ({
    mutant: { line, was: 'if (a > b) return 1;', now: 'if (a >= b) return 1;', kind: 'a boundary moved by one' },
    fate: 'noticed' as const,
    noticedBy: 'tests/shop.test.js',
    seconds: 0.4,
  });

  it('says how many of the file\'s changes it actually asked about', () => {
    const report = renderProof([proof({ tried: [caught(3), caught(9)], found: 20 })]);
    assert.match(report, /2 of the 20 change\(s\) were made/, 'the headline has to carry the sample size');
    assert.match(report, /allows 20 change\(s\) and 2 were taken/);
    assert.match(report, /Nothing above says anything about the other 18/);
    assert.match(report, /--limit 20/, 'and how to ask about the rest');
  });

  it('stays quiet about sampling when it tried everything', () => {
    const report = renderProof([proof({ tried: [caught(3), caught(9)], found: 2 })]);
    assert.match(report, /^2 change\(s\) were made/m, 'no "of the 2": there is nothing left to warn about');
    assert.doesNotMatch(report, /Nothing above says anything about/);
  });

  it('counts every change the file allows, not the sample', () => {
    const source = file(...Array.from({ length: 12 }, (unused, i) => `  if (x` + i + ` > ` + i + `) { total += 1; }`));
    assert.equal(candidateMutants(source).length, 12, 'twelve mutable lines');
    assert.equal(mutantsFor(source, 4).length, 4, 'and a sample of four when four is asked for');
  });
});

describe('quoting the change on a long line', () => {
  it('shows where the two versions differ instead of a cut that hides it', () => {
    const was = 'x'.repeat(200) + ' a - b ' + 'y'.repeat(50);
    const now = 'x'.repeat(200) + ' a + b ' + 'y'.repeat(50);
    const [left, right] = aroundTheChange(was, now);
    assert.notEqual(left, right, 'a was/became pair that reads identical is worse than no quote at all');
    assert.match(left, /a - b/);
    assert.match(right, /a \+ b/);
    assert.ok(left.startsWith('...'), 'and says that something was cut from the front');
  });

  it('leaves a line that fits exactly as it is', () => {
    const [left, right] = aroundTheChange('if (a > b) return 1;', 'if (a >= b) return 1;');
    assert.equal(left, 'if (a > b) return 1;');
    assert.equal(right, 'if (a >= b) return 1;');
  });

  it('does not lose the change when it is at the very start of the line', () => {
    const [left, right] = aroundTheChange('a === b ' + 'z'.repeat(300), 'a !== b ' + 'z'.repeat(300));
    assert.match(left, /a === b/);
    assert.match(right, /a !== b/);
    assert.ok(!left.startsWith('...'), 'nothing was cut from the front, so nothing should claim it was');
  });
});
