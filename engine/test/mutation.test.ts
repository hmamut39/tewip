// The stronger check: change the code under test and see whether the test notices. It is opt-in and
// narrow on purpose, so most of what matters here is refusing clearly and saying why.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Framework } from '../quality/frameworks.ts';
import { describeMutation, mutationTool, readMutationReport, sourceUnderTest } from '../quality/mutation.ts';

function project(tree: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-mut-'));
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const framework = (id: Framework['id'], cwd: string, label = id): Framework =>
  ({ id, label, browser: id === 'playwright', cwd, testDir: cwd, example: null, fileFor: (x: string) => x, command: () => '', suite: '' }) as Framework;

describe('choosing a mutation tool', () => {
  it('uses the project\'s own StrykerJS when it is installed', () => {
    const root = project({ 'node_modules/@stryker-mutator/core/package.json': '{}', 'src/cart.ts': '', 'src/cart.test.ts': '' });
    const tool = mutationTool(framework('vitest', root));
    assert.ok(tool && !('missing' in tool));
    assert.match((tool as { command: (a: string, b: string) => string }).command(join(root, 'src/cart.ts'), join(root, 'src/cart.test.ts')), /stryker run --mutate "src\/cart\.ts" --testFiles "src\/cart\.test\.ts"/);
  });

  it('says it is not installed, and how to install it, rather than installing anything', () => {
    const tool = mutationTool(framework('jest', project({ 'src/a.ts': '' })));
    assert.ok(tool && 'missing' in tool);
    assert.match((tool as { missing: string }).missing, /not installed/);
    assert.match((tool as { install: string }).install, /@stryker-mutator\/core/);
  });

  it('refuses browser frameworks, where every mutant costs a rebuild', () => {
    assert.equal(mutationTool(framework('playwright', project({ 'a.spec.ts': '' }))), null);
    assert.equal(mutationTool(framework('angular', project({ 'a.spec.ts': '' }))), null);
  });
});

describe('finding the code a test covers', () => {
  it('follows the test\'s own relative import, and never another test', () => {
    const root = project({ 'src/cart.ts': 'export const total = () => 0;', 'src/cart.test.ts': "import { total } from './cart';", 'src/helper.test.ts': '' });
    assert.equal(sourceUnderTest(join(root, 'src/cart.test.ts'), "import { total } from './cart';", root), join(root, 'src/cart.ts'));
    assert.equal(sourceUnderTest(join(root, 'src/cart.test.ts'), "import { render } from '@testing-library/react';", root), null);
  });
});

describe('reading what the mutation run found', () => {
  it('counts what the test noticed and names what it missed, with no percentage', () => {
    const root = project({
      'reports/mutation/mutation.json': JSON.stringify({
        files: {
          'src/cart.ts': {
            mutants: [
              { status: 'Killed' },
              { status: 'Killed' },
              { status: 'Survived', replacement: 'total - 1', location: { start: { line: 42 } } },
              { status: 'CompileError' },
            ],
          },
        },
      }),
    });
    const result = readMutationReport('stryker', root)!;
    assert.equal(result.noticed, 2);
    assert.deepEqual(result.missed, [{ line: 42, change: 'total - 1' }]);
    assert.equal(result.inconclusive, 1);
    const text = describeMutation(result, 'src/cart.ts');
    assert.match(text, /noticed 2 of 3 change\(s\) it exercised in src\/cart\.ts, missing line 42 \(total - 1\)/);
    assert.doesNotMatch(text, /%/, 'a mutation score percentage would sound like quality without being it');
  });

  it('says all changes were noticed when none survived', () => {
    const root = project({ 'reports/mutation/mutation.json': JSON.stringify({ files: { 'src/cart.ts': { mutants: [{ status: 'Killed' }, { status: 'Killed' }] } } }) });
    assert.match(describeMutation(readMutationReport('stryker', root)!, 'src/cart.ts'), /noticed all 2 change\(s\) it exercised/);
  });

  it('does not count changes in code the test never runs against it', () => {
    // A narrow test on a large file leaves most of the file untouched. Counting those as misses
    // would turn a correct test into an alarming number; the real measure is what it exercised.
    const root = project({
      'reports/mutation/mutation.json': JSON.stringify({
        files: { 'src/utils.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived', location: { start: { line: 75 } }, replacement: 'true' }, ...Array.from({ length: 429 }, () => ({ status: 'NoCoverage' }))] } },
      }),
    });
    const result = readMutationReport('stryker', root)!;
    assert.equal(result.notExercised, 429);
    const text = describeMutation(result, 'src/utils.ts');
    assert.match(text, /noticed 1 of 2 change\(s\) it exercised/);
    assert.match(text, /429 other change\(s\) there are in code this test does not run/);
  });
});
