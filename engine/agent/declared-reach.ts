// What a tool says about itself, and what to do when that is less than its own name admits.
//
// The other half of OWASP ASI09, Human-Agent Trust Exploitation. `gate-refuses.ts` covers an
// approval step that cannot refuse; this covers the pattern OWASP calls consent laundering - a
// person approves an action on the strength of a claim, and the claim is not checked.
//
// MCP tools carry `readOnlyHint` and `destructiveHint`, and reading them is right: an author
// saying what their own tool does is better evidence than a verb list. But the protocol is
// explicit about which direction that trust runs. The 2025-06-18 schema reference says clients
// "should never make tool use decisions based on ToolAnnotations received from untrusted servers",
// the spec's own default for a tool with no annotation is possibly destructive, and the
// maintainers' post on tool annotations puts the case in one line: **a server can claim
// `readOnlyHint: true` and delete your files anyway.**
//
// Tewip did the thing the spec warns against. `tools.ts` read the annotation first and the name
// second - "declared first, guessed second" - so a tool called `delete_customer` that declared
// `readOnlyHint: true` was printed in the report as **reads only**, under a heading a reader uses
// to decide what needs a person. The annotation is a claim by whoever wrote the server, the report
// is what somebody signs off against, and nothing compared the two.
//
// So the rule is now directional, which is what the spec asks for:
//
//   - An annotation that admits **more** than the name suggests is believed. `destructiveHint:
//     true` on a tool called `get_report` is an author telling you something you could not have
//     guessed, and there is no reason to doubt it.
//   - An annotation that claims **less** is reported, and the stronger reading wins. That is the
//     fail-closed direction, and it is the spec's own default.
//   - Where the name says nothing, there is nothing to contradict, and the annotation stands.
import { reachOf, type Reach } from './tools.ts';

/**
 * How bad each reach is, worst first.
 *
 * Taken from the order `REACH` already tests its word lists in, which is the same judgement made
 * once: a name matching both `delete` and `update` is a deletion. `destructive` sits above all of
 * them because it is the one that cannot be undone by definition, and `not-sure` sits below,
 * because it is the absence of a reading rather than a mild one.
 */
export const RANK: Record<Reach, number> = {
  destructive: 0,
  deletes: 1,
  pays: 2,
  'runs-code': 3,
  sends: 4,
  writes: 5,
  reads: 6,
  'not-sure': 7,
};

/** A claim a tool makes about itself that its own name does not support. */
export interface UnderClaim {
  /** What the annotation said. */
  claimed: Reach;
  /** Why it said it, quoting the annotation. */
  claimedWhy: string;
}

/**
 * What the author declared.
 *
 * Both shapes are read: written inline, and written once as a named constant and reused -
 * `annotations: readOnly`, with `const readOnly = { readOnlyHint: true, ... }` further up the same
 * file, which is how Tewip's own server does it and therefore the shape most likely to be missed
 * by a check written against the documentation instead of against real code.
 */
export function declaredHint(text: string, from: number): { reach: Reach; why: string } | null {
  const window = text.slice(from, from + 1200);
  const named = /annotations\s*:\s*([A-Za-z_$][\w$]*)/.exec(window);
  const where = named
    ? new RegExp(String.raw`\b(?:const|let|var)\s+${named[1]}\s*(?::[^=]{0,120})?=\s*\{([^}]{0,300})\}`).exec(text)?.[1] ?? ''
    : window;
  if (/destructiveHint\s*:\s*true/.test(where)) return { reach: 'destructive', why: 'its own annotation says destructiveHint: true' };
  if (/readOnlyHint\s*:\s*true/.test(where)) return { reach: 'reads', why: 'it declares readOnlyHint: true' };
  // Both written and both false is a decision too, and it was being read as no information.
  //
  // The MCP specification defines `readOnlyHint` as "if true, the tool does not modify its
  // environment", so an author who writes `readOnlyHint: false` beside `destructiveHint: false` has
  // said: this one writes, and it cannot destroy. nocodb's `linkRecords` declares exactly that and
  // came back **not decided** - printed under "read these yourself", beside `createRecords` and
  // `updateRecords` which carry the *same* two annotations and are classified only because their
  // names begin with a verb Tewip knows. A tool called `linkRecords` is not a worse-documented
  // tool; it is a tool whose name is not on a list.
  //
  // Only when both are present and both false. An absent `readOnlyHint` defaults to false in the
  // specification and says nothing about intent, so absence is still absence. Phase 215.
  if (/readOnlyHint\s*:\s*false/.test(where) && /destructiveHint\s*:\s*false/.test(where)) {
    return { reach: 'writes', why: 'its annotations say readOnlyHint: false and destructiveHint: false - it writes, and does not destroy' };
  }
  return null;
}

/**
 * The reach to report for one tool, and the claim it contradicts where there is one.
 *
 * `under` being set is the finding: the tool declared something safer than its own name says, and
 * the reported reach is the name's reading rather than the annotation's.
 */
export function reachFor(name: string, description: string, source: string, from: number): { reach: Reach; why: string; under: UnderClaim | null } {
  const guessed = reachOf(name, description);
  const declared = declaredHint(source, from);
  if (!declared) return { ...guessed, under: null };
  // The annotation admits at least as much as the name suggests. Believe it - that is an author
  // telling you something, and it is the direction the protocol's trust actually runs in.
  //
  // This one comparison also carries the case where the name says nothing at all, because
  // `not-sure` ranks below every real reading: any annotation is at least as severe as no reading,
  // so it stands. That started as a separate early return and sabotage showed it changed no
  // answer, which is the definition of a line to delete. What holds it now is the assertion in
  // declared-reach.test.ts that `not-sure` ranks last - so if that order is ever disturbed, the
  // test says so rather than nocodb's `linkRecords` quietly being accused.
  if (RANK[declared.reach] <= RANK[guessed.reach]) return { ...declared, under: null };
  return {
    reach: guessed.reach,
    // Short, because the section that lists these explains the contradiction in full and this
    // sentence also appears in the tool table and under "the ones that cannot be taken back".
    why: `${guessed.why}, and its own annotation claims less`,
    under: { claimed: declared.reach, claimedWhy: declared.why },
  };
}
