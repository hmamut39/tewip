// Opening a pull request is where Tewip touches somebody's repository, so these tests are about
// what it must never do: commit to the branch a person is standing on, sweep up files that were
// not part of the proved work, or claim more than was proved. The repository here is real, created
// and committed in a temporary folder, because none of that can be checked against a fake.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { branchNameFor, proposePullRequest, requestBody } from '../build/propose-pr.ts';

const NL = String.fromCharCode(10);

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-pr-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'cart.ts'), 'export const total = () => 0;', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return root;
}

const git = (root: string, ...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim();

describe('proposing the work as a pull request', () => {
  it('commits on a branch of its own and leaves the person\'s branch untouched', () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'cart.ts'), 'export const total = () => 1;', 'utf8');
    writeFileSync(join(root, 'src', 'tax.ts'), 'export const tax = () => 0.1;', 'utf8');

    const result = proposePullRequest({ root, files: ['src/cart.ts', 'src/tax.ts'], title: 'add tax to the total', body: 'the total now includes tax' });
    // There is no remote here, so pushing fails - and that is the interesting half: the work is
    // still committed, and Tewip says exactly what is left to do.
    assert.equal(result.status, 'committed');
    assert.match(result.branch ?? '', /^tewip\/add-tax-to-the-total-\d+$/);
    assert.match(result.next.join(' '), /push it yourself with: git push -u origin tewip\//);

    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), result.branch);
    assert.match(git(root, 'log', '-1', '--format=%s'), /add tax to the total/);
    assert.equal(git(root, 'log', '-1', '--format=%s', 'main'), 'first', 'the branch the person was on has not moved');
  });

  it('commits only the files that were proved, not whatever else was open', () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'cart.ts'), 'export const total = () => 1;', 'utf8');
    writeFileSync(join(root, 'notes.md'), 'my unrelated work in progress', 'utf8');

    proposePullRequest({ root, files: ['src/cart.ts'], title: 'change the total', body: 'why' });
    const committed = git(root, 'show', '--name-only', '--format=', 'HEAD').split(NL).filter(Boolean);
    assert.deepEqual(committed, ['src/cart.ts']);
    assert.match(git(root, 'status', '--porcelain'), /notes\.md/, 'the person\'s own file is still theirs, uncommitted');
  });

  it('refuses outside a git checkout, and with nothing to commit', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'tewip-plain-'));
    assert.equal(proposePullRequest({ root: notARepo, files: ['a.ts'], title: 't', body: 'b' }).status, 'refused');
    assert.match(proposePullRequest({ root: repo(), files: [], title: 't', body: 'b' }).next.join(' '), /nothing to commit/);
  });

  it('names a branch a person can read, and never the same one twice', () => {
    const first = branchNameFor('add a sep argument to naturalsize', new Date('2026-09-23T10:00:00Z'));
    const second = branchNameFor('add a sep argument to naturalsize', new Date('2026-09-23T10:01:00Z'));
    assert.match(first, /^tewip\/add-a-sep-argument-to-naturalsize-/);
    assert.notEqual(first, second);
  });
});

describe('what the pull request says', () => {
  it('says what was proved, and is explicit about what that does not mean', () => {
    const body = requestBody('adds a sep argument to naturalsize', ['src/humanize/filesize.py', 'tests/test_sep.py'], 'PROJ-12');
    assert.match(body, /adds a sep argument/);
    assert.match(body, /`src\/humanize\/filesize\.py`/);
    assert.match(body, /From: PROJ-12/);
    assert.match(body, /the test failed without this change and/);
    assert.match(body, /does \*\*not\*\* say: whether this is the design you want/);
    assert.match(body, /Tewip never merges anything/);
  });
});
