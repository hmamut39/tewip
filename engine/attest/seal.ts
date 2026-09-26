// Sealing an attestation, and being precise about what a seal is worth.
//
// The roadmap promised a "signed" bundle and the first implementation signed nothing. This closes
// that, but the honest part is the distinction it refuses to blur:
//
//   A **digest** says the content matches the fingerprint recorded inside it. Anybody who edits the
//   bundle can recompute the fingerprint, so on its own it proves only that nothing was corrupted
//   in transit - not that nobody changed it on purpose. It is still worth having: it gives a bundle
//   a stable identity that a release note or a ticket can quote.
//
//   A **signature** says the holder of a private key produced this exact content. That is the claim
//   people mean by "signed", and it is only available when a key exists.
//
// A tool that prints "signed" over a bare hash is doing the thing this whole project exists not to
// do, so the words are kept apart everywhere: in the type, in the report, and in the verifier.
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

export interface Seal {
  /** sha256 over the bundle's content, excluding the seal itself. */
  digest: string;
  /** Base64 Ed25519 signature over the digest, when a key was available. */
  signature?: string;
  /** How it was signed, so a verifier knows what to do with it. */
  algorithm?: 'ed25519';
}

export interface Sealed {
  seal?: Seal;
  [key: string]: unknown;
}

/**
 * The bundle's content, in a form that hashes the same everywhere: keys in order, the seal itself
 * left out, and the time it was produced kept in, because a bundle for a different moment is a
 * different bundle.
 */
export function canonical(bundle: Sealed): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== 'seal')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, ordered(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(ordered(bundle));
}

export const digestOf = (bundle: Sealed): string => createHash('sha256').update(canonical(bundle)).digest('hex');

/**
 * Seals a bundle: always a digest, and a signature when a key is given. The key is a PEM Ed25519
 * private key, from `TEWIP_ATTEST_KEY` (a path or the PEM itself). Nothing is generated silently:
 * without a key there is no signature and the bundle says so rather than implying one.
 */
export function seal(bundle: Sealed, privateKeyPem?: string): Seal {
  const digest = digestOf(bundle);
  if (!privateKeyPem?.trim()) return { digest };
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the signing key is ${key.asymmetricKeyType}, and Tewip signs with ed25519`);
    return { digest, signature: cryptoSign(null, Buffer.from(digest, 'hex'), key).toString('base64'), algorithm: 'ed25519' };
  } catch (error) {
    // A key that does not work is not a reason to ship an unmarked bundle quietly.
    throw new Error(`the attestation could not be signed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface Checked {
  /** True when the content still hashes to the digest recorded inside it. */
  contentMatches: boolean;
  signature: 'valid' | 'invalid' | 'absent' | 'no-key-given';
  /** What was actually established, in words that do not overstate it. */
  says: string;
}

/** Checks a sealed bundle, and says exactly what that check does and does not establish. */
export function check(bundle: Sealed, publicKeyPem?: string): Checked {
  const recorded = bundle.seal?.digest ?? '';
  const contentMatches = Boolean(recorded) && recorded === digestOf(bundle);
  if (!recorded) {
    return { contentMatches: false, signature: 'absent', says: 'this bundle carries no digest at all, so nothing about it can be checked' };
  }
  if (!contentMatches) {
    return { contentMatches: false, signature: bundle.seal?.signature ? 'invalid' : 'absent', says: 'the content does not match the digest recorded inside it: it has been changed since it was written' };
  }
  if (!bundle.seal?.signature) {
    return {
      contentMatches: true,
      signature: 'absent',
      says: 'the content matches its own digest, and nothing more: no signature was made, so this shows the bundle is undamaged, not that nobody edited it - an editor can recompute a digest',
    };
  }
  if (!publicKeyPem?.trim()) {
    return { contentMatches: true, signature: 'no-key-given', says: 'the content matches its own digest and carries a signature, but no public key was given, so the signature was not checked' };
  }
  try {
    const ok = cryptoVerify(null, Buffer.from(recorded, 'hex'), createPublicKey(publicKeyPem), Buffer.from(bundle.seal.signature, 'base64'));
    return {
      contentMatches: true,
      signature: ok ? 'valid' : 'invalid',
      says: ok
        ? 'the content matches its digest and the signature is the holder of that key over this exact content'
        : 'the content matches its digest, but the signature does not belong to this key and this content',
    };
  } catch (error) {
    return { contentMatches: true, signature: 'invalid', says: `the signature could not be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
}
