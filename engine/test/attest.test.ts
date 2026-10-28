// Phase 15: the evidence as one artifact. What these tests protect is the property that makes an
// attestation worth anything - it may only contain what Tewip verified itself, and it must say
// what it refused and what it never looked at. A bundle that quietly drops the undecided failures
// would read better and mean nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attestRun, renderAttestation } from '../attest/attest.ts';
import { generateKeyPairSync } from 'node:crypto';
import { check, digestOf, seal } from '../attest/seal.ts';
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

  it('counts a rule that could not decide as a refusal, not as a decision', () => {
    // In CI the bundle read "2 decided by deterministic rules" while listing one of them under
    // Refused. A rule that looked and could not say has not decided anything.
    const records = [decided('a > one', 'ENV'), undecided('a > two')];
    const a = bundle(records);
    assert.equal(a.claims.length + a.refusals.length, 2);
    assert.equal(a.claims.length, 1, 'only the one it actually settled');
  });

  it('says plainly when a run had nothing to explain', () => {
    const report = renderAttestation(bundle([]));
    assert.match(report, /None: nothing failed/);
    assert.match(report, /Nothing was left undecided/);
  });

  it('reads like a green run when nothing failed', () => {
    // The first live CI bundle said "0 decided by deterministic rules, 0 sent to the model" about a
    // run where every test passed: true, and it tells a reader nothing.
    const a = attestRun('shop', run(), [], { checked: ['every test in the run passed: 3 attempted, none failed'], notChecked: ['tests that passed'], tool: 'tewip', engine: 'rules-9' });
    const report = renderAttestation(a);
    assert.match(report, /every test in the run passed/);
    assert.doesNotMatch(report, /0 decided/);
    assert.match(report, /None: nothing failed/);
  });

  it('doubts its own silence when nothing is recorded as unchecked', () => {
    const empty = attestRun('shop', run(), [], { checked: [], notChecked: [], tool: 'tewip', engine: 'rules-9' });
    const report = renderAttestation(empty).split(NL);
    assert.ok(report.some((l) => /this bundle makes no claims/.test(l)));
    assert.ok(report.some((l) => /itself worth doubting/.test(l)));
  });
});

// Phase 70: the seal, attacked rather than described. Real ed25519 keys, a real bundle, and the
// oldest attack on a signature - removing it.
describe('what --verify establishes, and what it must refuse to', () => {
  const keys = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      pub: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    };
  };
  const bundleOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ project: 'p', failures: 0, notChecked: ['a blind spot'], claims: [{ what: 'a' }], ...over });
  const sealed = (priv?: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
    const body = bundleOf(over);
    return { ...body, seal: seal(body as never, priv) };
  };

  it('accepts a bundle signed by the key it is checked against', () => {
    const { priv, pub } = keys();
    const checked = check(sealed(priv) as never, pub);
    assert.equal(checked.contentMatches, true);
    assert.equal(checked.signature, 'valid');
  });

  it('refuses a bundle whose signature was removed, when a key was given', () => {
    // The attack, measured: change a fact, erase the blind-spot list, delete the signature,
    // recompute the digest. `attest --verify bundle.json --key release.pem` printed
    // "Content matches its digest: yes" and **exited 0**, so any gate scripted on it passed.
    const { priv, pub } = keys();
    const forged: Record<string, unknown> = { ...sealed(priv), failures: 99, notChecked: [], seal: { digest: '' } };
    forged.seal = { digest: digestOf(forged as never) };

    const checked = check(forged as never, pub);
    assert.equal(checked.contentMatches, true, 'the digest really does match - that is the point');
    assert.equal(checked.signature, 'stripped', 'and it is still not something to trust');
    assert.match(checked.says, /carries no signature/);
    assert.match(checked.says, /anyone who edits a bundle can recompute its digest/);
  });

  it('does not claim a signature was never made, only that there is none', () => {
    // "no signature was made" asserts something about the bundle's history that cannot be known
    // from the bundle: it may have been removed.
    const checked = check(sealed(undefined) as never);
    assert.equal(checked.signature, 'absent');
    assert.doesNotMatch(checked.says, /no signature was made/);
    assert.match(checked.says, /carries no signature/);
  });

  it('refuses a signature made by a different key', () => {
    const mine = keys();
    const theirs = keys();
    assert.equal(check(sealed(mine.priv) as never, theirs.pub).signature, 'invalid');
  });

  it('says the signature was not checked when no key is given, rather than valid', () => {
    const { priv } = keys();
    const checked = check(sealed(priv) as never);
    assert.equal(checked.signature, 'no-key-given');
    assert.match(checked.says, /no public key was given, so the signature was not checked/);
  });

  it('covers a field named seal anywhere but the top level', () => {
    // The seal has to be left out of its own digest - but the filter ran at every depth, so content
    // under `claims[0].seal` was invisible to it and could be added without changing the digest or
    // invalidating the signature over it.
    const plain = digestOf(bundleOf({ claims: [{ what: 'a', seal: 'nothing' }] }) as never);
    const smuggled = digestOf(bundleOf({ claims: [{ what: 'a', seal: 'payload' }] }) as never);
    assert.notEqual(plain, smuggled, 'a nested seal field has to be part of the content');
  });

  it('still leaves the top-level seal out of its own digest', () => {
    const body = bundleOf();
    const withSeal = (digest: string) => ({ ...body, seal: { digest } }) as never;
    assert.equal(digestOf(withSeal('aaa')), digestOf(withSeal('bbb')));
  });
});

// Phase 114: a signed bundle that counted the same failure three times.
//
// The reporter writes one record per attempt, so a retried test arrived here three times and
// became three identical claims under a `failures` count that agreed with them. In the worst real
// gutenberg run that is 492 claims about 164 failing tests; 50 of its 283 runs were affected. Of
// everything in Tewip this is the worst place for it: an attestation exists to be checked by
// somebody who was not there, and a count they cannot trust makes the rest of it worthless.
//
// The sharper half was the contradiction. Where one attempt was decided and another was not, the
// same test produced a claim *and* a refusal - one sealed document asserting a cause and
// disclaiming it at the same time.
describe('a retried test is one failure, even in a signed bundle', () => {
  const thrice = (testId: string, category: string) => [decided(testId, category), decided(testId, category), decided(testId, category)];

  it('makes one claim about a test that failed three times, and says it failed three times', () => {
    const a = bundle(thrice('a > three', 'ENV'));
    assert.equal(a.claims.length, 1, 'three attempts at one failing test are one claim');
    assert.equal(a.claims[0].attempts, 3, 'and the three attempts are recorded, not discarded');
    assert.equal(a.failures, 1, 'one test failed, however many times it was retried');
  });

  it('never claims and disclaims the same test at once', () => {
    // Attempt one undecided, attempt two decided: the test is decided.
    const a = bundle([undecided('a > three'), decided('a > three', 'TIMING')]);
    assert.equal(a.claims.length, 1);
    assert.equal(a.claims[0].attempts, 2);
    assert.deepEqual(a.refusals, [], 'a decided test is not also a refusal');
    assert.equal(a.failures, 1);
  });

  it('still refuses a test no attempt of which was ever decided', () => {
    // The guard above must not be bought by letting a decided attempt launder an undecided test.
    const a = bundle([undecided('a > three'), undecided('a > three')]);
    assert.deepEqual(a.claims, [], 'nothing was settled, so nothing is claimed');
    assert.equal(a.refusals.length, 1, 'and it is refused once, not once per attempt');
    assert.equal(a.failures, 1);
  });

  it('keeps separate tests separate', () => {
    const a = bundle([...thrice('a > one', 'ENV'), ...thrice('a > two', 'TIMING')]);
    assert.equal(a.claims.length, 2);
    assert.equal(a.failures, 2);
    assert.deepEqual(a.claims.map((c) => c.attempts), [3, 3]);
  });
});
