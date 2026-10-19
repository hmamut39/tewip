// Can a tampered attestation be made to verify?
//
// `attest` is the one command whose wrong answer is not a bad report but a false guarantee: if it
// calls a bundle authentic after somebody edited it, every gate scripted on it passes a lie.
//
// So these are not happy-path tests. A bundle is sealed and then attacked fifteen ways - change a
// fact, add one, delete one, reorder, recompute the digest over the forgery, strip the signature,
// present a different key, hide content where the digest used not to look. The only answer that
// counts as a hole is `authentic`, and the control at the end is what stops a verifier that simply
// refuses everything from passing this file.
//
// Two of these fail only because of earlier work: hiding content under a nested `seal` key is the
// Phase 70 fix that made the digest skip only the top-level seal, and stripping the signature after
// recomputing the digest is the `stripped` state added beside it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { check, digestOf, seal, type Sealed } from '../attest/seal.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIVATE = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');
const OTHER_PUBLIC = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const bundleOf = (): Sealed =>
  ({
    subject: 'tewip-ai@0.70.16',
    claims: [
      { name: 'tests', passed: 1290, failed: 0 },
      { name: 'coverage', lines: 0.82 },
    ],
    notChecked: ['the running application', 'load under concurrency'],
  }) as unknown as Sealed;

const sealed = (): Sealed => {
  const b = bundleOf();
  (b as Record<string, unknown>).seal = seal(b, PRIVATE);
  return b;
};

/** Each attack returns a tampered bundle, and the key the verifier is given. */
const ATTACKS: Array<[string, () => { bundle: Sealed; key?: string }]> = [
  ['change a claim, leave the seal alone', () => { const b = sealed() as any; b.claims[0].failed = 7; return { bundle: b, key: PUBLIC }; }],
  ['change a claim and recompute the digest', () => { const b = sealed() as any; b.claims[0].failed = 7; b.seal.digest = digestOf(b); return { bundle: b, key: PUBLIC }; }],
  ['erase what was not checked', () => { const b = sealed() as any; b.notChecked = []; b.seal.digest = digestOf(b); return { bundle: b, key: PUBLIC }; }],
  ['strip the signature, recompute the digest', () => { const b = sealed() as any; b.claims[0].failed = 7; delete b.seal.signature; b.seal.digest = digestOf(b); return { bundle: b, key: PUBLIC }; }],
  ['add a field nobody sealed', () => { const b = sealed() as any; b.approvedBy = 'nobody'; return { bundle: b, key: PUBLIC }; }],
  ['delete a field', () => { const b = sealed() as any; delete b.notChecked; return { bundle: b, key: PUBLIC }; }],
  ['hide content under a nested seal key', () => { const b = sealed() as any; b.claims[0].seal = { smuggled: true }; return { bundle: b, key: PUBLIC }; }],
  ['reorder the claims array', () => { const b = sealed() as any; b.claims.reverse(); return { bundle: b, key: PUBLIC }; }],
  ['present a different public key', () => ({ bundle: sealed(), key: OTHER_PUBLIC })],
  ['replace the signature with another key\'s', () => { const a = sealed() as any; const b = bundleOf() as any; b.seal = seal(b, other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()); a.seal.signature = b.seal.signature; return { bundle: a, key: PUBLIC }; }],
  ['truncate the digest', () => { const b = sealed() as any; b.seal.digest = b.seal.digest.slice(0, 32); return { bundle: b, key: PUBLIC }; }],
  ['blank the digest', () => { const b = sealed() as any; b.seal.digest = ''; return { bundle: b, key: PUBLIC }; }],
  ['remove the seal entirely', () => { const b = sealed() as any; delete b.seal; return { bundle: b, key: PUBLIC }; }],
  ['change a number to its string form', () => { const b = sealed() as any; b.claims[0].passed = '1290'; return { bundle: b, key: PUBLIC }; }],
  ['unicode: decompose an accent', () => { const b = sealed() as any; b.subject = 'tewip-ai@0.70.16́'; return { bundle: b, key: PUBLIC }; }],
];

describe('an attestation that has been tampered with', () => {
  for (const [name, build] of ATTACKS) {
    it(`refuses: ${name}`, () => {
      const { bundle, key } = build();
      const result = check(bundle, key);
      const authentic = result.contentMatches && result.signature === 'valid';
      assert.equal(authentic, false, `${name} was accepted as authentic`);
      assert.ok(result.says.length > 0, 'and says why');
    });
  }

  it('still verifies a bundle nobody touched', () => {
    // Without this, a verifier that refused everything would pass every test above.
    const result = check(sealed(), PUBLIC);
    assert.equal(result.contentMatches, true);
    assert.equal(result.signature, 'valid');
  });
});
