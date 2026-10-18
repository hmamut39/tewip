// Phase 21: the first place Tewip does something because it decided to, rather than because a
// person typed it. Almost everything worth testing here is a refusal.
//
// What these tests hold: only an allowlisted action can run, every other action is refused by name
// rather than falling through, the scenario id is read from the decision instead of guessed, the
// same attempt is not made twice over one report, and whatever happened is written down where the
// team can read it. If autonomy widens later it has to widen by editing the allowlist, and one of
// these tests will notice.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { alreadyTried, cannotAct, planFor, type ActionRecord } from '../pursue/act.ts';
import type { Act, Decision } from '../pursue/policy.ts';
import { actionsTaken, cliEntry, observe, runPursue } from '../pursue/pursue-command.ts';
import { decide } from '../pursue/policy.ts';
import { saveCorrections, type Correction } from '../corrections.ts';
import { errorShape } from '../signature.ts';

const NL = String.fromCharCode(10);

const ACTS: Act[] = ['look-first', 'triage-real-bug', 'rerun-environment', 'settle-flaky', 'triage-undecided', 'cover-gap', 'attest', 'stand-down'];

const decision = (act: Act, next = ''): Decision => ({ act, next, why: 'because', evidence: [], changesFiles: false });

const did = (over: Partial<ActionRecord> = {}): ActionRecord => ({
  at: '2026-09-26T09:00:00.000Z',
  goal: 'g',
  act: 'cover-gap',
  target: 'scenario CT-002',
  command: 'tewip write --only CT-002',
  runId: 'r1',
  outcome: 'done',
  detail: 'kept',
  ...over,
});

describe('what Tewip may carry out on its own', () => {
  it('carries out only the two actions on the allowlist', () => {
    const allowed = ACTS.filter((act) => planFor(decision(act, 'write a test for CT-002')) !== null);
    assert.deepEqual(allowed, ['cover-gap', 'attest'], 'widening this needs a deliberate edit, not an accident');
  });

  it('accounts for every action, so none can fall through in silence', () => {
    for (const act of ACTS) {
      const plan = planFor(decision(act, 'write a test for CT-002'));
      const why = cannotAct[act];
      if (plan) assert.equal(why, '', act + ' is carried out, so it needs no refusal text');
      else assert.ok(why && why.length > 10, act + ' is refused but says nothing a person could act on');
    }
  });

  it('reads the scenario id out of the decision instead of guessing one', () => {
    const named = planFor(decision('cover-gap', 'write a test for CT-002, the highest priority thing nothing checks'));
    assert.deepEqual(named?.command, ['write', '--only', 'CT-002']);
    assert.equal(planFor(decision('cover-gap', 'cover the gaps somehow')), null, 'no id in the sentence means nothing runs');
  });

  it('will not make the same attempt twice over one report, and a new run unblocks it', () => {
    const records = [did()];
    assert.ok(alreadyTried(records, 'cover-gap', 'scenario CT-002', 'r1'), 'the same evidence is not worth a second attempt');
    assert.equal(alreadyTried(records, 'cover-gap', 'scenario CT-002', 'r2'), null, 'a newer run is new evidence');
    assert.equal(alreadyTried(records, 'cover-gap', 'scenario CT-009', 'r1'), null, 'a different scenario is a different attempt');
    assert.equal(alreadyTried([did({ outcome: 'refused' })], 'cover-gap', 'scenario CT-002', 'r1'), null, 'refusing costs nothing and blocks nothing');
    assert.ok(alreadyTried([did({ outcome: 'failed' })], 'cover-gap', 'scenario CT-002', 'r1'), 'a failed attempt is not retried at the same thing');
  });
});

/** A project with one kept run, so pursue has something real to observe. */
function project(failures: Array<{ testId: string; category: string }>, scenarios: Array<Record<string, string>> = []): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-act-'));
  const history = join(root, '.tewip', 'history', 'shop');
  mkdirSync(history, { recursive: true });
  const runId = 'r1';
  const attempted = [...failures.map((f) => f.testId), 'tests/cart.test.js > checkout keeps totals'];
  const run = { schemaVersion: 1, runId, gitSha: '', startedAt: '2026-09-26T10:00:00.000Z', finishedAt: '2026-09-26T10:00:00.000Z', status: 'failed', attempts: Object.fromEntries(attempted.map((t) => [t, 1])) };
  writeFileSync(join(history, 'runs.jsonl'), JSON.stringify(run) + NL);
  const lines = failures.map((f) =>
    JSON.stringify({ schemaVersion: 1, testId: f.testId, file: 'f', status: 'failed', errorMessage: 'boom', errorStack: '', duration: 1, retry: 0, attachments: [], runId, gitSha: '', timestamp: '2026-09-26T10:00:00.000Z', diagnosis: { category: f.category, confidence: 0.8, source: 'rules', evidence: [{ message: 'a rule said so' }] } }),
  );
  writeFileSync(join(history, 'triage.jsonl'), lines.length > 0 ? lines.join(NL) + NL : '');
  if (scenarios.length > 0) {
    mkdirSync(join(root, '.tewip', 'plans'), { recursive: true });
    writeFileSync(join(root, '.tewip', 'plans', 'checkout.json'), JSON.stringify({ feature: 'checkout', plan: { title: 'Checkout', scenarios } }));
  }
  return root;
}

/** pursue prints its report; these tests care about the audit file, not the noise. */
function quietly<T>(work: () => T): T {
  const said = console.log;
  console.log = () => {};
  try {
    return work();
  } finally {
    console.log = said;
  }
}

describe('the audit trail of what it did', () => {
  it('refuses a real bug by name and writes the refusal down, having run nothing', () => {
    const root = project([{ testId: 'tests/checkout.test.js > totals the order', category: 'REAL_BUG' }]);
    const { decision: chose } = quietly(() => runPursue({ root, goal: 'keep checkout green', act: true }));
    assert.equal(chose.act, 'triage-real-bug');
    const [entry, ...rest] = actionsTaken(root);
    assert.deepEqual(rest, [], 'one decision, one line');
    assert.equal(entry.outcome, 'refused');
    assert.equal(entry.command, '', 'nothing was run');
    assert.match(entry.detail, /a person/);
    assert.equal(entry.goal, 'keep checkout green');
  });

  it('writes nothing at all when it was not asked to act', () => {
    const root = project([{ testId: 'tests/checkout.test.js > totals the order', category: 'REAL_BUG' }]);
    quietly(() => runPursue({ root, goal: 'keep checkout green' }));
    assert.deepEqual(actionsTaken(root), [], 'deciding is not doing, and leaves no trace');
  });

  it('declines to repeat an attempt it already made on the same run, and says when it tried', () => {
    const root = project([], [{ id: 'CT-002', title: 'applies a discount', priority: 'P1' }]);
    writeFileSync(join(root, '.tewip', 'actions.jsonl'), JSON.stringify(did({ outcome: 'failed', detail: 'the drafted test never failed when broken' })) + NL);
    const { decision: chose } = quietly(() => runPursue({ root, goal: 'checkout', act: true }));
    assert.equal(chose.act, 'cover-gap');
    const records = actionsTaken(root);
    assert.equal(records.length, 2, 'the refusal is recorded beside the attempt it refers to');
    assert.equal(records[1].outcome, 'refused');
    assert.match(records[1].detail, /same evidence/);
  });

  it('keeps the audit file readable line by line, so a broken line loses one entry and not the file', () => {
    const root = project([{ testId: 'tests/checkout.test.js > totals the order', category: 'REAL_BUG' }]);
    writeFileSync(join(root, '.tewip', 'actions.jsonl'), JSON.stringify(did()) + NL);
    quietly(() => runPursue({ root, goal: 'keep checkout green', act: true }));
    const lines = readFileSync(join(root, '.tewip', 'actions.jsonl'), 'utf8').trim().split(NL);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(JSON.parse(line).at, 'every line stands on its own');
  });

  it('re-enters its own command line, not whatever started the process', () => {
    // The bug this holds shut: the first version spawned process.argv[1], which under a test runner
    // is the test file. Acting ran the test file, which acted, which ran it again. The machine it
    // was written on froze. Nothing may be spawned unless it is demonstrably Tewip.
    const entry = cliEntry();
    assert.ok(entry, 'a checkout or an installed build always has a command line beside it');
    assert.match(entry.replace(/\\/g, '/'), /\/cli\/tewip\.(ts|js)$/, 'the only thing worth re-entering is the Tewip command line');
    assert.doesNotMatch(entry, /test/, 'a test runner is never the entry point');
  });
});

// Phase 79: field-tested against a real diagnosed history. The decision order holds, --act refuses a
// goal it cannot explain, and every refusal is recorded. One thing did not hold.
describe('a person telling pursue that something is a real bug', () => {
  const NL2 = String.fromCharCode(10);
  const record = (testId: string, category: string, confidence: number) => ({
    schemaVersion: 1, testId, file: 'shop.spec.ts', status: 'failed',
    errorMessage: 'TimeoutError: locator.click: Timeout 1500ms exceeded', errorStack: '',
    duration: 1, retry: 0, attachments: [], runId: 'r1', gitSha: '', timestamp: '2026-01-01T00:00:00Z',
    diagnosis: { category, confidence, source: 'rules rules-3', evidence: [], engineVersion: 'rules-3', diagnosedAt: '2026-01-01T00:00:00Z' },
  });
  const project = (withCorrection: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-pursue-'));
    const where = join(root, '.tewip', 'history', 'shop');
    mkdirSync(where, { recursive: true });
    writeFileSync(join(where, 'triage.jsonl'), [record('shop.spec.ts > starts checkout', 'LOCATOR_DRIFT', 0.95), record('shop.spec.ts > opens the cart', 'LOCATOR_DRIFT', 0.9)].map((r) => JSON.stringify(r)).join(NL2) + NL2, 'utf8');
    writeFileSync(join(where, 'runs.jsonl'), JSON.stringify({ schemaVersion: 1, runId: 'r1', gitSha: '', branch: 'main', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z', status: 'failed', attempts: { 'shop.spec.ts > starts checkout': 1, 'shop.spec.ts > opens the cart': 1 } }) + NL2, 'utf8');
    if (withCorrection) {
      saveCorrections(where, [{ schemaVersion: 1, testId: 'shop.spec.ts > starts checkout', errorShape: errorShape('TimeoutError: locator.click: Timeout 1500ms exceeded'), category: 'REAL_BUG', wasCategory: 'LOCATOR_DRIFT', by: 'sam', at: '2026-01-02T00:00:00Z', reason: 'the button is gone' } as unknown as Correction]);
    }
    return root;
  };

  it('reaches the decision, so a real bug is treated as a real bug', () => {
    // This read `r.diagnosis` straight off the record, so a correction never arrived. It matters more
    // here than in a report, because this is the command that acts - and its own documented order is
    // "a real bug first... it will not touch a real bug", a rule that depends on recognising one.
    const seen = observe(project(true), 'keep the shop checkout green');
    const corrected = seen.failing.find((f) => f.testId === 'shop.spec.ts > starts checkout');
    assert.equal(corrected?.category, 'REAL_BUG');
    assert.equal(decide('keep the shop checkout green', seen).act, 'triage-real-bug');
  });

  it('leaves a failure nobody corrected as it was', () => {
    const seen = observe(project(true), 'keep the shop checkout green');
    assert.equal(seen.failing.find((f) => f.testId === 'shop.spec.ts > opens the cart')?.category, 'LOCATOR_DRIFT');
  });

  it('decides differently without the correction, which is the bug this pins', () => {
    const seen = observe(project(false), 'keep the shop checkout green');
    assert.equal(seen.failing.every((f) => f.category === 'LOCATOR_DRIFT'), true);
    assert.notEqual(decide('keep the shop checkout green', seen).act, 'triage-real-bug', 'nothing has been called a real bug here');
  });

  it('will not act on a real bug, whoever decided it was one', () => {
    const seen = observe(project(true), 'keep the shop checkout green');
    const decision = decide('keep the shop checkout green', seen);
    assert.match(cannotAct[decision.act] ?? '', /a real bug is for a person to see/);
  });
});
