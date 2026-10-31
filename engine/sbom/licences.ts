// What a licence means for a company shipping software, and when Tewip does not know.
//
// Every SBOM tool fills this in. Most of them fill it in by guessing: a package with no declared
// licence becomes "NOASSERTION" buried in a field nobody reads, or worse, is quietly dropped from
// the count so the report looks complete. A licence inventory that is wrong in the permissive
// direction is the one that gets a company sued, so the rule here is the project's usual one -
// say "not stated" and show it, rather than assume the common case.
//
// Classification only, no advice. Whether AGPL is acceptable is a decision for a lawyer and a
// business model, not for a test tool, and a report that says "remove this dependency" about a
// licence it has not read the terms of is worth less than one that says what the licence is.

export type Standing =
  | 'permissive' // MIT and friends: use it, keep the notice
  | 'weak-copyleft' // LGPL, MPL, EPL: changes to the library itself come back
  | 'strong-copyleft' // GPL, AGPL: can reach your own source, depending on how you ship
  | 'source-available' // BUSL, SSPL, Elastic: not open source, and the terms vary
  | 'not-stated' // nobody said, and Tewip will not pick one
  | 'not-recorded'; // the lockfile format does not carry licences, so nobody has looked yet

export interface Classified {
  /** The expression exactly as the package declared it. */
  declared: string;
  standing: Standing;
  /** What this means in one line a non-lawyer can act on. */
  means: string;
}

/** Matched against each licence id in an expression, most specific first. */
const FAMILIES: Array<[RegExp, Standing, string]> = [
  [/^(agpl|gnu affero)/i, 'strong-copyleft', 'reaches your own source even when you only run it as a service'],
  [/^(gpl|gnu general)/i, 'strong-copyleft', 'can require you to publish source that links to it, depending on how you ship'],
  [/^(lgpl|gnu lesser)/i, 'weak-copyleft', 'changes to this library must be published; your own code usually need not be'],
  [/^(mpl|mozilla public)/i, 'weak-copyleft', 'changes to its own files must be published; your other files need not be'],
  [/^(epl|eclipse public|cddl|cpl)/i, 'weak-copyleft', 'changes to its own files must be published'],
  [/^(busl|bsl|sspl|elastic|commons.clause|polyform)/i, 'source-available', 'not open source: the terms restrict how you may run or resell it'],
  [/^(mit|apache|bsd|isc|0bsd|unlicense|cc0|zlib|python-2|psf|wtfpl|artistic|postgresql|openssl)/i, 'permissive', 'use it and keep the notice'],
];

const NOT_STATED = /^(unlicensed|noassertion|none|unknown|see licen[cs]e|proprietary|custom)$/i;

/**
 * The standing of a licence expression.
 *
 * SPDX expressions are not a single id: `(MIT OR Apache-2.0)` is a choice and `MIT AND GPL-3.0`
 * is both at once. A choice is as free as its freest option, because you may take that option; a
 * conjunction is as constrained as its most constrained part, because you must obey all of them.
 * Treating either as a single string - which is what reading the first id does - gets one of them
 * backwards, and the one it gets backwards is the one that matters.
 */
export function classify(declared: unknown): Classified {
  const text = typeof declared === 'string' ? declared.trim() : typeof (declared as { type?: string })?.type === 'string' ? (declared as { type: string }).type.trim() : '';
  if (!text || NOT_STATED.test(text)) {
    return {
      declared: text || '(none)',
      standing: 'not-stated',
      means: 'this package does not say what licence it is under, so nobody can say whether you may ship it',
    };
  }
  const ids = text.split(/\s+(?:OR|AND)\s+|[()]/i).map((p) => p.trim()).filter(Boolean);
  const parts = ids.map(one);
  const choice = /\bOR\b/i.test(text) && !/\bAND\b/i.test(text);
  // A choice: the freest option is the one you may take. Otherwise: the strictest binds.
  const order: Standing[] = ['permissive', 'weak-copyleft', 'strong-copyleft', 'source-available', 'not-stated'];
  const pick = choice
    ? parts.reduce((best, p) => (order.indexOf(p.standing) < order.indexOf(best.standing) ? p : best))
    : parts.reduce((worst, p) => (order.indexOf(p.standing) > order.indexOf(worst.standing) ? p : worst));
  return { declared: text, standing: pick.standing, means: pick.means };
}

function one(id: string): Classified {
  for (const [re, standing, means] of FAMILIES) if (re.test(id)) return { declared: id, standing, means };
  return {
    declared: id,
    standing: 'not-stated',
    means: `Tewip does not recognise "${id}", so it will not guess what it allows`,
  };
}

/** The standings a company usually wants to look at before shipping. */
/**
 * The standings a company usually wants to look at before shipping.
 *
 * `not-recorded` is deliberately not here. A pnpm lockfile carries no licences, so immich's 2,705
 * packages all arrive unread - and a report announcing that 2,705 packages need a lawyer is the
 * kind of alarm people turn off. Not knowing because the format does not say is a gap in the
 * scan; not knowing because the package did not say is a finding about the package. They get
 * counted apart and reported apart.
 */
export const NEEDS_A_LOOK: Standing[] = ['strong-copyleft', 'source-available', 'not-stated'];
