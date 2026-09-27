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
