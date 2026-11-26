// Which tests reach a change through another module, and which only look as if they do.
//
// This walk had no test of any kind, and it produces the "reaches it through N import(s)" evidence
// that `tewip done` prints on the row a release decision leans on. The tokens it matches with are
// substrings of a quoted import path, so a token has to identify the file it stands for - and
// `index` identifies every front door in a project.
//
// Measured on immich, whose `packages/sdk/src/index.ts` contributed the bare token `index`: 65
// server specs that import `src/schema/index.js` - a different file in a different package - were
// reported as two hops from a change to `packages/sdk/src/fetch-client.ts`, and `tewip done` said
// 79 test files reached that change. The other half of the same defect is that it could not leave
// the package at all: it missed all 58 test files that really do import `@immich/sdk`.
//
// The fixture below is immich's shape, small enough to count by hand. Phase 223.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { importNames } from '../review/imports.ts';
import { testsReaching } from '../prove/reaches.ts';

const NL = String.fromCharCode(10);

function project(): { root: string; tests: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-reach-'));
  const write = (rel: string, text: string): string => {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
    return full;
  };

  // A package whose front door re-exports the changed file.
  write('packages/sdk/src/fetch-client.ts', 'export const fetchClient = (u: string) => fetch(u);' + NL);
  write('packages/sdk/src/index.ts', "export * from './fetch-client';" + NL);
  write('packages/sdk/package.json', `${JSON.stringify({ name: '@acme/sdk', version: '1.0.0' })}${NL}`);

  // Another corner of the repo, with its own front door, whose tests import it by a path alias.
  write('server/src/schema/index.ts', 'export const schema = 1;' + NL);
  const unrelated = write(
    'server/test/schema.spec.ts',
    "import { schema } from 'src/schema/index.js';" + NL + "it('works', () => { expect(schema).toBe(1); });" + NL,
  );

  // A test that really does use the package, the only way anything outside it can.
  const consumer = write(
    'web/test/uses-sdk.spec.ts',
    "import { fetchClient } from '@acme/sdk';" + NL + "it('works', () => { expect(fetchClient).toBeDefined(); });" + NL,
  );
  return { root, tests: [unrelated, consumer] };
}

describe('following a change through the import graph', () => {
  it('reaches a test that imports the package the change is re-exported from', () => {
    const { root, tests } = project();
    const found = testsReaching(root, 'packages/sdk/src/fetch-client.ts', tests);
    assert.deepEqual(
      found.map((f) => f.testFile),
      ['web/test/uses-sdk.spec.ts'],
      'the one test that imports @acme/sdk, and only it',
    );
    assert.equal(found[0].steps, 2, 'the change, its front door, then the test');
  });

  it('does not reach a test because it imports some other front door', () => {
    // `server/test/schema.spec.ts` imports `src/schema/index.js`. Under the bare token `index`
    // that counted as importing `packages/sdk/src/index.ts`, which is a different file in a
    // different package. 65 of immich's specs were counted this way.
    const { root, tests } = project();
    const found = testsReaching(root, 'packages/sdk/src/fetch-client.ts', tests).map((f) => f.testFile);
    assert.ok(!found.includes('server/test/schema.spec.ts'), 'a different index is a different file');
  });

  it('names a front door by its folder and its package, never by the word index', () => {
    const { root } = project();
    const names = importNames(root, 'packages/sdk/src/index.ts');
    assert.ok(!names.includes('index'), '`index` is a position, not a module name');
    assert.ok(names.includes('@acme/sdk'), 'the published name is how anything outside imports it');
    assert.ok(names.includes('src/index'), 'and the folder distinguishes it from another front door');
    // `src` on its own matches any import path ending in `src`: 341 of immich's files.
    assert.ok(!names.includes('src'), 'a container folder is not a name');
  });

  it('still names an ordinary file by its own basename', () => {
    const { root } = project();
    const names = importNames(root, 'packages/sdk/src/fetch-client.ts');
    assert.ok(names.includes('fetch-client'), 'a real module name identifies its file');
    assert.ok(names.includes('packages/sdk/src/fetch-client'));
  });

  it('keeps a front door whose folder is a real name, because that is what identifies it', () => {
    const { root } = project();
    const names = importNames(root, 'server/src/schema/index.ts');
    assert.ok(names.includes('schema/index'), 'this is the token its own tests match on');
    assert.ok(names.includes('schema'));
    assert.ok(!names.includes('index'));
  });
});
