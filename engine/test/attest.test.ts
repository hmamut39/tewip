// Phase 15: the evidence as one artifact. What these tests protect is the property that makes an
// attestation worth anything - it may only contain what Tewip verified itself, and it must say
// what it refused and what it never looked at. A bundle that quietly drops the undecided failures
// would read better and mean nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attestRun, renderAttestation } from '../attest/attest.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);

const run = (): RunSummary => ({
  schemaVersion: 1,
  runId: 'run-7',
  gitSha: 'abcdef1234567890',
  startedAt: '2026-09-26T10:00:00.000Z',
  finishedAt: '2026-09-26T10:04:00.000Z',
  status: 'failed',
  attempts: { 'a > one': 1, 'a > two': 1, 'a > three': 2 },
});

const failure = (testId: string, diagnosis: unknown): TriageRecord =>
  ({ schemaVersion: 1, testId, file: 'tests/a.spec.ts', status: 'failed', errorMessage: 'boom', errorStack: '', duration: 1, retry: 0, attachments: [], runId: 'run-7', gitSha: '', timestamp: '2026-09-26T10:01:00.000Z', diagnosis }) as unknown as TriageRecord;

const decided = (testId: string, category: string, source = 'rules') =>
  failure(testId, { category, confidence: 0.9, source, evidence: [{ source: 'env-network', message: 'error shows a connection problem: "socket hang up"' }] });

const undecided = (testId: string) => failure(testId, { category: 'UNKNOWN', confidence: 0, source: 'rules', evidence: [{ source: 'engine', message: 'no rule applies to this kind of failure' }] });

const bundle = (records: TriageRecord[]) =>
  attestRun('shop', run(), records, { checked: ['every failing test was read'], notChecked: ['tests that passed'], tool: 'tewip', engine: 'rules-9' });

describe('the attestation', () => {
  it('states each claim with its evidence, the layer that decided it, and the run it came from', () => {
    const a = bundle([decided('a > one', 'ENV')]);
    assert.equal(a.claims.length, 1);
    assert.equal(a.claims[0].decidedBy, 'rules');
    assert.equal(a.claims[0].runId, 'run-7');
    assert.match(a.claims[0].evidence, /socket hang up/);
    assert.equal(a.commit, 'abcdef1234567890');
  });

  it('records an undecided failure as a refusal, never as a claim', () => {
    // The whole value of the bundle rests on this. A tool that never says "I could not tell" has
    // nothing to attest, because any line it writes might be a guess.
    const a = bundle([decided('a > one', 'ENV'), undecided('a > two')]);
    assert.equal(a.claims.length, 1);
    assert.equal(a.refusals.length, 1);
    assert.match(a.refusals[0].what, /a > two/);
    assert.match(a.refusals[0].why, /no rule applies/);
  });

  it('refuses to claim anything with no source, however confident it looks', () => {
    const a = bundle([failure('a > three', { category: 'REAL_BUG', confidence: 0.99, evidence: [] })]);
    assert.deepEqual(a.claims, [], 'a diagnosis with no deciding layer is not evidence of anything');
    assert.equal(a.refusals.length, 1);
  });

  it('counts the tests the runner counted, not the failures it explains', () => {
    const a = bundle([decided('a > one', 'ENV')]);
    assert.equal(a.testsAttempted, 3);
    assert.equal(a.failures, 1);
  });

  it('puts the refusals and the unchecked in the report, not in a footnote', () => {
    const report = renderAttestation(bundle([decided('a > one', 'ENV'), undecided('a > two')]));
    assert.match(report, /## What was NOT checked/);
    assert.match(report, /## Refused \(1\)/);
    assert.match(report, /cannot be trusted about the rest/);
    assert.match(report, /This is a statement/);
  });

  it('says plainly when a run had nothing to explain', () => {
    const report = renderAttestation(bundle([]));
    assert.match(report, /None: nothing failed/);
    assert.match(report, /Nothing was left undecided/);
  });

  it('doubts its own silence when nothing is recorded as unchecked', () => {
    const empty = attestRun('shop', run(), [], { checked: [], notChecked: [], tool: 'tewip', engine: 'rules-9' });
    const report = renderAttestation(empty).split(NL);
    assert.ok(report.some((l) => /this bundle makes no claims/.test(l)));
    assert.ok(report.some((l) => /itself worth doubting/.test(l)));
  });
});
