// Phase 8: making a hand-written test value unique. The second run is the proof - a value that is
// not really unique collides with the record its own first run created - so most of these tests are
// about that, and about refusing clearly when the database never said what collided.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { PlannedAction } from '../decide.ts';
import type { AutofixDeps } from '../autofix/autofix.ts';
import { collision, dataFixCandidates, findLiteral } from '../autofix/data.ts';
import { attemptDataFix, dataFixDiff } from '../autofix/fix-data.ts';

const SPEC = 'C:/repo/tests/signup.spec.ts';
const SOURCE = [
  "import { expect, test } from '@playwright/test';",
  '',
  "test('signs a new reader up', async ({ page, request }) => {",
  "  const res = await request.post('/api/users', { data: { email: 'user@example.com' } });",
  '  expect(res.status()).toBe(201);',
  '});',
].join('\n');

const PG = 'duplicate key value violates unique constraint "users_email_key"\nDETAIL:  Key (email)=(user@example.com) already exists.';
const record = (errorMessage: string): TriageRecord => ({
  schemaVersion: 1, testId: 'tests/signup.spec.ts > signs a new reader up', file: 'tests/signup.spec.ts', status: 'failed',
  errorMessage, errorStack: 'at tests/signup.spec.ts:4:20', duration: 300, retry: 0, attachments: [], runId: 'r1', gitSha: 'abc', timestamp: '2026-09-22T10:00:00Z',
});
const diagnosis = { category: 'TEST_DATA', confidence: 0.8, source: 'rules', evidence: [], engineVersion: 'rules-9', diagnosedAt: '' } as unknown as Diagnosis;
const action = { kind: 'fix-precondition', owner: 'sdet', autonomous: true, summary: '', reason: '' } as PlannedAction;

function deps(outcomes: boolean[], source = SOURCE) {
  const files = new Map([[SPEC, source]]);
  let run = 0;
  const d: AutofixDeps = {
    allowedRoot: 'C:/repo/tests',
    readFile: (p) => files.get(p) ?? '',
    writeFile: (p, c) => void files.set(p, c),
    verify: async () => ({ passed: outcomes[Math.min(run++, outcomes.length - 1)], detail: 'run' }),
    loadSnapshot: () => null,
  };
  return { d, files, runs: () => run };
}

describe('making a colliding test value unique', () => {
  it('replaces the value and proves it with a second run', async () => {
    const { d, files, runs } = deps([true, true]);
    const fix = await attemptDataFix({ record: record(PG), diagnosis, action, specFile: SPEC }, d);
    assert.equal(fix.status, 'fixed');
    assert.equal(runs(), 2, 'the second run is what shows the value is different every time');
    assert.match(files.get(SPEC)!, /`user\+\$\{Date\.now\(\)\}@example\.com`/);
    assert.match(dataFixDiff(fix, 'tests/signup.spec.ts'), /-'user@example\.com'/);
  });

  it('rejects a fix that collides with the record its own first run created', async () => {
    const { d, files } = deps([true, false]);
    const fix = await attemptDataFix({ record: record(PG), diagnosis, action, specFile: SPEC }, d);
    assert.equal(fix.status, 'all-candidates-failed');
    assert.equal(files.get(SPEC), SOURCE, 'the file must be exactly as it was');
  });

  it('refuses when the database named only the constraint, which is the common real case', async () => {
    // Straight from Supabase CI: no value, so there is nothing safe to make unique.
    const { d, runs } = deps([true, true]);
    const fix = await attemptDataFix({ record: record('Error: Database query failed: duplicate key value violates unique constraint "pg_extension_name_index"'), diagnosis, action, specFile: SPEC }, d);
    assert.equal(fix.status, 'value-unknown');
    assert.match(fix.log.at(-1)!, /does not print the value/);
    assert.equal(runs(), 0);
  });

  it('refuses when the value lives in a fixture rather than the test', async () => {
    const { d } = deps([true, true], SOURCE.replace("'user@example.com'", 'fixtures.newUser.email'));
    assert.equal((await attemptDataFix({ record: record(PG), diagnosis, action, specFile: SPEC }, d)).status, 'value-not-in-test');
  });

  it('never touches a file outside the tests directory', async () => {
    const { d } = deps([true, true]);
    assert.equal((await attemptDataFix({ record: record(PG), diagnosis, action, specFile: SPEC }, { ...d, allowedRoot: 'C:/repo/tests/e2e' })).status, 'outside-sandbox');
  });
});

describe('reading what collided', () => {
  it('reads the value when the database prints it, and the constraint when it does not', () => {
    assert.deepEqual(collision(PG), { where: 'email', value: 'user@example.com' });
    assert.deepEqual(collision('UNIQUE constraint failed: projects.slug'), { where: 'projects.slug', value: null });
    assert.deepEqual(collision("Duplicate entry 'my-project' for key 'projects.slug_unique'"), { where: 'projects.slug_unique', value: 'my-project' });
    assert.equal(collision("expected 'Hello' to equal 'Hi'"), null);
  });

  it('writes a unique value in the test\'s own language, keeping an email a valid email', () => {
    assert.equal(dataFixCandidates('user@example.com', 'js')[0].expression, '`user+${Date.now()}@example.com`');
    assert.equal(dataFixCandidates('my-project', 'python')[0].expression, 'f"my-project-{int(time.time() * 1000)}"');
    assert.equal(dataFixCandidates('my-project', 'java')[0].expression, '"my-project-" + System.currentTimeMillis()');
    assert.deepEqual(dataFixCandidates('my-project', 'other'), []);
  });

  it('finds the value where the test writes it, in any quote style', () => {
    assert.equal(findLiteral(SOURCE, 'user@example.com').length, 1);
    assert.equal(findLiteral('const a = "x-1"; const b = `x-1`;', 'x-1').length, 2);
  });
});

// Phase 118: the same hole in the data fixer. See autofix.test.ts for how it is reachable.
describe('the original value goes back when the verifier throws', () => {
  it('restores the file and lets the error through', async () => {
    const files = new Map([[SPEC, SOURCE]]);
    let wroteAChange = false;
    const d: AutofixDeps = {
      allowedRoot: 'C:/repo/tests',
      readFile: (p) => files.get(p) ?? '',
      writeFile: (p, c) => {
        if (c !== SOURCE) wroteAChange = true;
        files.set(p, c);
      },
      verify: async (): Promise<{ passed: boolean; detail: string }> => {
        throw new TypeError('The "file" argument must be of type string. Received undefined');
      },
      loadSnapshot: () => null,
    };
    await assert.rejects(() => attemptDataFix({ record: record(PG), diagnosis, action, specFile: SPEC }, d), /must be of type string/);
    assert.equal(wroteAChange, true, 'this proves nothing unless a candidate really was written');
    assert.equal(files.get(SPEC), SOURCE);
  });
});
