// Reading a token instead of recognising its shape.
//
// Split out of secrets.ts when it crossed 300 lines, and the seam is a real one: finding a
// credential and understanding one are different jobs, and only this half ever opens the value.
/**
 * Token types that positively declare the thing is not an access credential.
 *
 * An allowlist, not a denylist, and the difference is the whole lesson. The first version of this
 * asked "is the typ one of the credential types I know?" and treated everything else as safe,
 * which in a security scanner gets the burden of proof backwards. Measured against keycloak, that
 * rule quietly reclassified 38 real tokens as harmless - among them `vc+sd-jwt` and `dc+sd-jwt`,
 * which are *verifiable credentials*, and one fixture whose typ is the word "unexpected". An
 * unrecognised type means Tewip does not know what the token is, and not knowing is a reason to
 * keep judging it as before.
 *
 * So the only types here are ones that say, in their own name, that no issuer holds a credential
 * matching them. There is exactly one so far, found on real code; more belong here only when a
 * real repository produces one.
 */
const NOT_A_CREDENTIAL = /(^|[+/])licen[cs]e([+/]|$)/;

/**
 * What a JWT declares itself to be, when that is not a credential.
 *
 * RFC 8725 asks issuers to type their tokens explicitly, and the ones that do are telling you
 * what the thing is for. Tewip was matching the shape of a JWT and never opening it, which
 * produced the only "go and revoke this" verdict across ten real repositories - against
 * Bitwarden's `GlobalSettings.cs`, where the value is a Duende IdentityServer product licence.
 * Its own header says `"typ":"license+jwt"` and its payload is issued by duendesoftware.com to
 * "Bitwarden Inc.". There is no issuer to revoke it at and no accident to clean up: it is meant
 * to ship, in source, in a password manager read by a lot of people.
 *
 * Only the header is read, and only its `typ`. A type label is not a credential, so quoting it
 * keeps the rule this file is built on - a secret is located, never printed.
 */
export function declaredPurpose(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[0].startsWith('ey')) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { typ?: unknown };
    const typ = typeof header.typ === 'string' ? header.typ.trim().toLowerCase() : '';
    return typ && NOT_A_CREDENTIAL.test(typ) ? typ : null;
  } catch {
    return null; // not decodable, so not something to reason from
  }
}
