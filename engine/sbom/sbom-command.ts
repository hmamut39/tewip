// `tewip sbom`: the bill of materials procurement asks for, and the licences nobody read.
//
// Two outputs from one pass. CycloneDX JSON because that is the format a procurement team or a
// customer's security questionnaire actually asks for, and a page a person can read, because the
// JSON answers "what is in it" and only the page answers "and is any of it a problem".
//
// What makes this one worth having rather than another SBOM generator: it will not fill a gap it
// cannot read. A package with no declared licence is counted and listed, not quietly labelled
// NOASSERTION in a field nobody opens, and an ecosystem Tewip cannot read is named in the report
// instead of being left out of the total.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inventory, type Component, type Inventory } from './inventory.ts';
import { NEEDS_A_LOOK, type Standing } from './licences.ts';

export interface SbomCommand {
  root: string;
  /** Write the CycloneDX document here. */
  out?: string;
  /** Exit non-zero when a licence needs a person to look at it, for a CI gate. */
  gate?: boolean;
}

const ORDER: Standing[] = ['not-stated', 'source-available', 'strong-copyleft', 'weak-copyleft', 'permissive', 'not-recorded'];
const TITLE: Record<Standing, string> = {
  'not-stated': 'No licence stated',
  'not-recorded': 'Licence not read',
  'source-available': 'Source-available, not open source',
  'strong-copyleft': 'Strong copyleft',
  'weak-copyleft': 'Weak copyleft',
  permissive: 'Permissive',
};

/** A Package URL, which is how every other tool in this space names a component. */
const purl = (c: Component): string => `pkg:${c.ecosystem}/${c.name.replace('@', '%40')}@${c.version}`;

/**
 * CycloneDX 1.6. The fields a consumer actually reads, and no more.
 *
 * `licenses` is left off a component whose licence is not stated, rather than written as
 * NOASSERTION. Both are honest in the specification; only one of them is honest in a spreadsheet,
 * where a cell reading NOASSERTION sorts next to a cell reading MIT and gets skimmed past.
 */
export function cycloneDx(inv: Inventory, project: string): Record<string, unknown> {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      tools: { components: [{ type: 'application', name: 'tewip', description: 'reads what the project wrote down; does not resolve or guess' }] },
      component: { type: 'application', name: project },
      properties: inv.notRead.map((why) => ({ name: 'tewip:not-read', value: why })),
    },
    components: inv.components.map((c) => ({
      type: 'library',
      name: c.name,
      version: c.version,
      purl: purl(c),
      scope: c.dev ? 'excluded' : 'required',
      // Omitted for both kinds of not-knowing. Writing `(none)` or NOASSERTION into the document
      // puts a cell next to MIT in somebody's spreadsheet that sorts and skims like a licence -
      // caught by running this on immich, where 2,705 pnpm components each carried `(none)`.
      ...(c.licence.standing === 'not-stated' || c.licence.standing === 'not-recorded' ? {} : { licenses: [{ expression: c.licence.declared }] }),
    })),
  };
}

export function renderSbom(inv: Inventory, wrote: string | null): string {
  const shipped = inv.components.filter((c) => !c.dev);
  const byStanding = new Map<Standing, Component[]>();
  for (const c of inv.components) byStanding.set(c.licence.standing, [...(byStanding.get(c.licence.standing) ?? []), c]);
  const flagged = inv.components.filter((c) => NEEDS_A_LOOK.includes(c.licence.standing));

  const lines = [
    '# What this project ships, and under what licence',
    '',
    `${inv.components.length} package(s): ${shipped.length} that ship with the product, ${inv.components.length - shipped.length} needed only to build or test it.`,
    '',
  ];

  if (inv.components.length === 0) {
    lines.push('Nothing was read. The section below says why, and that is the whole answer - an empty bill of materials is not a short one.', '');
  }

  for (const standing of ORDER) {
    const group = byStanding.get(standing);
    if (!group || group.length === 0) continue;
    lines.push(`## ${TITLE[standing]} — ${group.length}`, '');
    if (standing === 'permissive') {
      lines.push(`${group.length} package(s), nothing to decide. Keep the notices.`, '');
      continue;
    }
    // Counted apart from "no licence stated" on purpose: this is a gap in the scan, not a
    // finding about the packages, and folding the two together would announce that every
    // dependency of a pnpm project needs a lawyer.
    if (standing === 'not-recorded') {
      lines.push(
        `${group.length} package(s). ${group[0].licence.means}.`,
        '',
        'This is a gap in the scan, not a finding about these packages. Install the dependencies and run this again and the licences are read from `node_modules`.',
        '',
      );
      continue;
    }
    lines.push(`${group[0].licence.means}.`, '');
    for (const c of group.slice(0, 20)) lines.push(`- \`${c.name}@${c.version}\` — ${c.licence.declared}${c.dev ? ' *(build only)*' : ''}`);
    if (group.length > 20) lines.push(`- …and ${group.length - 20} more`);
    lines.push('');
  }

  lines.push('## What is not in this list', '');
  if (inv.notRead.length === 0) {
    lines.push('Nothing found that Tewip could not read.', '');
  } else {
    for (const why of inv.notRead) lines.push(`- ${why}`);
    lines.push('', 'These are gaps, not zeroes. A bill of materials that leaves them out silently is the one somebody signs.', '');
  }

  lines.push(
    flagged.length === 0
      ? 'No licence here needs a decision from a person, on what Tewip could read.'
      : `**${flagged.length} package(s) need a person to look**: a licence Tewip does not recognise, one that is not open source, or none stated at all. Tewip does not say whether they are acceptable - that depends on how you ship and is a question for a lawyer.`,
    '',
  );
  if (wrote) lines.push(`CycloneDX 1.6 written to \`${wrote}\`.`, '');
  lines.push('No model was called and nothing was fetched: this is read from the files in the project.');
  return lines.join('\n');
}

export function runSbom(cmd: SbomCommand): { report: string; flagged: number } {
  const root = resolve(cmd.root);
  const inv = inventory(root);
  let wrote: string | null = null;
  if (cmd.out) {
    const path = resolve(cmd.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cycloneDx(inv, root.split(/[\\/]/).pop() ?? 'project'), null, 2)}\n`, 'utf8');
    wrote = cmd.out;
  }
  const report = renderSbom(inv, wrote);
  console.log(report);
  const flagged = inv.components.filter((c) => NEEDS_A_LOOK.includes(c.licence.standing)).length;
  if (cmd.gate && flagged > 0) process.exitCode = 1;
  return { report, flagged };
}
