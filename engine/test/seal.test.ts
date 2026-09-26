// Sealing an attestation. The roadmap promised a "signed" bundle and the first implementation
// signed nothing, which is the overclaim this project exists not to make. These tests hold the
// distinction that closing it depends on: a digest says the file is undamaged, and only a
// signature checked against a key says who made it. Printing "signed" over a bare hash would be
// the same overclaim wearing a hash.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { canonical, check, digestOf, seal } from '../attest/seal.ts';

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};

const bundleOf = (over: Record<string, unknown> = {}) => ({ project: 'shop', claims: [{ claim: 'a failed', runId: 'r1' }], refusals: [], ...over });

describe('sealing a bundle', () => {
  it('hashes the content and not the seal, so a sealed bundle still verifies', () => {
    const b = bundleOf();
    const sealed = { ...b, seal: seal(b) };
    assert.equal(digestOf(sealed), sealed.seal.digest, 'the digest is of the content, never of itself');
    assert.equal(check(sealed).contentMatches, true);
  });

  it('hashes the same whatever order the keys arrive in', () => {
    assert.equal(canonical({ b: 1, a: 2 } as never), canonical({ a: 2, b: 1 } as never));
  });

  it('catches a bundle somebody edited', () => {
    const b = bundleOf();
    const sealed = { ...b, seal: seal(b) } as Record<string, unknown>;
    const tampered = { ...sealed, claims: [] };
    const checked = check(tampered);
    assert.equal(checked.contentMatches, false);
    assert.match(checked.says, /changed since it was written/);
  });

  it('will not call a digest a signature', () => {
    const b = bundleOf();
    const checked = check({ ...b, seal: seal(b) });
    assert.equal(checked.signature, 'absent');
    assert.match(checked.says, /an editor can recompute a digest/);
  });

  it('signs with a key, and the signature checks out against the public one', () => {
    const { pub, priv } = keys();
    const b = bundleOf();
    const sealed = { ...b, seal: seal(b, priv) };
    assert.equal(sealed.seal.algorithm, 'ed25519');
    const checked = check(sealed, pub);
    assert.equal(checked.signature, 'valid');
    assert.match(checked.says, /the holder of that key over this exact content/);
  });

  it('rejects a signature made for different content', () => {
    const { pub, priv } = keys();
    const b = bundleOf();
    const sealed = { ...b, seal: seal(b, priv) } as Record<string, unknown>;
    const checked = check({ ...sealed, project: 'somewhere else' }, pub);
    assert.equal(checked.contentMatches, false);
  });

  it('rejects a signature from the wrong key', () => {
    const mine = keys();
    const theirs = keys();
    const b = bundleOf();
    const checked = check({ ...b, seal: seal(b, mine.priv) }, theirs.pub);
    assert.equal(checked.signature, 'invalid');
    assert.match(checked.says, /does not belong to this key/);
  });

  it('says a signature went unchecked rather than implying it passed', () => {
    const { priv } = keys();
    const b = bundleOf();
    const checked = check({ ...b, seal: seal(b, priv) });
    assert.equal(checked.signature, 'no-key-given');
    assert.match(checked.says, /the signature was not checked/);
  });

  it('refuses to ship quietly when a key is given but unusable', () => {
    assert.throws(() => seal(bundleOf(), 'not a key at all'), /could not be signed/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(() => seal(bundleOf(), rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), /ed25519/);
  });

  it('says nothing can be checked when there is no digest', () => {
    const checked = check(bundleOf());
    assert.equal(checked.contentMatches, false);
    assert.match(checked.says, /carries no digest at all/);
  });
});
