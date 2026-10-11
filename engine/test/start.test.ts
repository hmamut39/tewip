// The front door: `tewip` with nothing after it.
//
// It used to print 233 lines of help listing eleven commands - a reference for somebody who already
// knows what they want, and a wall for everybody else. Eleven commands is already more than most
// teams will run; the problem was never how many things Tewip can do, it was that none of them were
// connected to the repository the person was standing in.
//
// The tests that matter here are about honesty at the moment of first contact. A count that is
// wrong is worse at the front door than anywhere else, because it is the one place a person has no
// way to check. And a front door that implies Tewip can do everything is the same lie as a report
// with no limits on it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { lookAround, renderStart, suggest } from '../start/start-command.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-start-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

const A_TEST = "describe('cart', () => { it('adds', () => { expect(1).toBe(1); }); });";
const A_MIGRATION = 'ALTER TABLE "Share" DROP COLUMN "userId";';

describe('looking around a project', () => {
  it('counts the test files, by the language they are written in', () => {
    const root = project({
      'src/cart.test.ts': A_TEST,
      'src/checkout.test.ts': A_TEST,
      'tests/api_test.py': 'def test_totals():\n    assert 1 == 1\n',
      'src/cart.ts': 'export const x = 1;',
    });
    const found = lookAround(root);
    assert.equal(found.tests.get('js'), 2);
    assert.equal(found.tests.get('python'), 1);
    assert.equal([...found.tests.values()].reduce((a, b) => a + b, 0), 3, 'source that is not a test must not be counted');
  });

  it('spends its budget on breadth, not on whatever the alphabet leads to first', () => {
    // Pointed at Tewip itself, a depth-first walk descended into `data/`, spent its whole budget
    // on stored datasets, and reported 7 test files in a repository with 69. Breadth-first sees
    // every top-level directory before descending into any of them.
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) files[`aaa-data/deep/nested/row-${i}.json`] = '{}';
    files['zzz-src/cart.test.ts'] = A_TEST;
    const found = lookAround(project(files), 200);
    assert.equal(found.tests.get('js'), 1, 'the test file must be found despite coming last alphabetically');
  });

  it('recognises migrations and markup', () => {
    const found = lookAround(
      project({
        'prisma/migrations/0001_init/migration.sql': A_MIGRATION,
        'src/App.vue': '<template><img src="a.png"></template>',
        'results/run.jtl': 'timeStamp,elapsed,label\n1,2,x\n',
      }),
    );
    assert.equal(found.migrations.get('sql'), 1);
    assert.equal(found.markup, 1);
    assert.deepEqual(found.perfReports, ['results/run.jtl']);
  });

  it('does not wander into node_modules or the build output', () => {
    const found = lookAround(
      project({ 'node_modules/pkg/index.test.js': A_TEST, 'dist/bundle.test.js': A_TEST, 'src/real.test.js': A_TEST }),
    );
    assert.equal(found.tests.get('js'), 1);
  });
});

describe('what it suggests', () => {
  it('names the commands that fit what is actually here, most useful first', () => {
    const found = lookAround(project({ 'src/a.test.ts': A_TEST, 'migrations/0001.sql': A_MIGRATION }));
    const commands = suggest(found).map((s) => s.command);
    assert.equal(commands[0], 'tewip vouch');
    assert.ok(commands.some((c) => c.startsWith('tewip schema')));
    assert.ok(!commands.includes('tewip access'), 'there is no markup here');
  });

  it('every suggestion says why, in terms of this project', () => {
    const found = lookAround(project({ 'src/a.test.ts': A_TEST }));
    for (const s of suggest(found)) assert.ok(s.because.length > 30, s.command);
    assert.match(suggest(found)[0].because, /1 test file here/);
  });

  it('points at a performance report the project already has', () => {
    const found = lookAround(project({ 'src/a.test.ts': A_TEST, 'perf/results.jtl': 'timeStamp,elapsed,label\n1,2,x\n' }));
    assert.ok(suggest(found).some((s) => s.command === 'tewip perf perf/results.jtl'));
  });
});

describe('what it says it cannot do', () => {
  it('names every gap rather than implying it can do everything', () => {
    const report = renderStart(lookAround(project({ 'src/a.test.ts': A_TEST })), '/p');
    assert.match(report, /What it will not do here/);
    assert.match(report, /No migrations were found/);
    assert.match(report, /No markup was found/);
    assert.match(report, /does not run load tests itself/);
  });

  it('a project with nothing it can judge gets an honest answer, not a menu', () => {
    const report = renderStart(lookAround(project({ 'README.md': '# hello', 'LICENSE': 'MIT' })), '/p');
    assert.match(report, /found nothing it can judge/);
    assert.match(report, /honest answer rather than a failure/);
  });

  it('an empty directory is said to be empty', () => {
    assert.match(renderStart(lookAround(mkdtempSync(join(tmpdir(), 'tewip-empty-'))), '/p'), /nothing to read/);
  });

  it('always points at the full list for somebody who wants it', () => {
    const report = renderStart(lookAround(project({ 'src/a.test.ts': A_TEST })), '/p');
    assert.match(report, /tewip --help/);
    assert.match(report, /cannot say.*rather than guessing/);
  });
});
