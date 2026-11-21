// Every capability an agent in this project has, written down so a new one cannot arrive quietly.
//
// "Agent registry: every agent and its owner. No shadow agents." appears in five of the seven
// national governance frameworks published in 2025 and 2026, and in both guardrail catalogues. The
// control they are all describing is not a list - a list is easy, and `tewip agent` already prints
// one. It is the *comparison*: knowing that what is here today is what somebody approved, and being
// told when it is not.
//
// So this is a baseline and a diff. The inventory is sorted, stable and hashed, and the hash is the
// whole point: it changes when a capability appears, disappears or changes reach, and it does not
// change when a file moves or a comment is edited. A reader who approved `a1b2c3` once can be told
// that the project is now `d4e5f6` and exactly which three tools account for it.
//
// This is also what ASI10 needs. "A rogue agent acts outside its authorised scope" presumes a scope
// somebody wrote down, and almost nobody does. A baseline somebody accepted *is* that scope, which
// is why this comes before any attempt at ASI10 rather than after it.
import { createHash } from 'node:crypto';
import type { AgentScan } from './scan.ts';

const NL = String.fromCharCode(10);

export interface Capability {
  /** What kind of thing this is: a tool the model may call, a gate, or a door. */
  kind: 'tool' | 'guard' | 'door' | 'mcp-server';
  /** The name a person would recognise it by. */
  name: string;
  /** For a tool, how far it reaches. For a guard, nothing. */
  reach?: string;
  /** Where it is, so the entry can be checked rather than believed. */
  file?: string;
}

export interface Inventory {
  capabilities: Capability[];
  /** Stable across a file move or a comment; changes when a capability does. */
  hash: string;
  at: string;
}

/**
 * The line a capability is identified by.
 *
 * Deliberately without the file or the line number. A tool that moves between files is the same
 * tool, and an inventory whose hash changed every time somebody reorganised a directory would be
 * one people learn to re-baseline without reading - which is the whole failure this is built
 * against. The file is kept on the entry for a reader; it is not part of what is hashed.
 */
const identity = (c: Capability): string => `${c.kind}:${c.name}${c.reach ? `:${c.reach}` : ''}`;

/**
 * The fingerprint of a list, computed rather than read.
 *
 * A stored baseline carries its own `hash`, and that field is the thing a person approved - but it
 * is also a number in a file somebody can edit, and the two can disagree. When they do, the report
 * printed `x to x` beside a list of changes, which reads as a bug in the diff rather than as a
 * baseline that has been touched. So the displayed fingerprint is always derived from the
 * capabilities beside it, and always describes the list it is printed next to.
 */
export function hashOf(capabilities: Capability[]): string {
  const sorted = [...capabilities].sort((a, b) => identity(a).localeCompare(identity(b)));
  return createHash('sha256').update(sorted.map(identity).join(NL)).digest('hex').slice(0, 12);
}

export function inventoryOf(scan: AgentScan, now = new Date()): Inventory {
  const capabilities: Capability[] = [
    ...scan.tools.map((t): Capability => ({ kind: 'tool', name: t.name, reach: t.reach, file: t.file })),
    // One entry per guard kind, not per place it is written. Six `max_iterations` in six files are
    // one control, and listing them six times makes a diff unreadable for no gain.
    ...[...new Set(scan.guards.map((g) => g.kind))].map((kind): Capability => ({ kind: 'guard', name: kind })),
    ...scan.doors.map((d): Capability => ({ kind: 'door', name: d.door, file: d.file })),
    ...scan.config.servers.map((s): Capability => ({ kind: 'mcp-server', name: s.name, reach: s.where })),
  ];
  // Sorted so the hash does not depend on the order files were walked in, which differs between
  // platforms and would make the same project hash two ways.
  capabilities.sort((a, b) => identity(a).localeCompare(identity(b)));
  return { capabilities, hash: hashOf(capabilities), at: now.toISOString() };
}

export interface Change {
  added: Capability[];
  removed: Capability[];
}

/** What arrived and what went, between a baseline somebody accepted and what is here now. */
export function changedSince(baseline: Inventory, now: Inventory): Change {
  const before = new Set(baseline.capabilities.map(identity));
  const after = new Set(now.capabilities.map(identity));
  return {
    added: now.capabilities.filter((c) => !before.has(identity(c))),
    removed: baseline.capabilities.filter((c) => !after.has(identity(c))),
  };
}

/** Reach values that cannot be undone, which is what makes an addition worth interrupting for. */
const IRREVERSIBLE = ['destructive', 'deletes', 'pays', 'sends', 'runs-code'];

export function renderInventory(now: Inventory, baseline: Inventory | null, at = 'tewip-agents.json'): string[] {
  const lines = ['## What this project lets an agent do', ''];
  if (now.capabilities.length === 0) {
    return [...lines, 'No agent tool, gate, interface or configured MCP server was found, so there is nothing to record.', ''];
  }
  lines.push(
    `${now.capabilities.length} capabilit(ies), fingerprint \`${now.hash}\`. The fingerprint is what to approve: it changes when a ` +
      'capability appears, disappears or changes reach, and does not change when a file moves.',
    '',
    '| kind | name | reach | where |',
    '| --- | --- | --- | --- |',
  );
  for (const c of now.capabilities.slice(0, 60)) lines.push(`| ${c.kind} | \`${c.name}\` | ${c.reach ?? ''} | ${c.file ?? ''} |`);
  if (now.capabilities.length > 60) lines.push(`…and ${now.capabilities.length - 60} more`);
  lines.push('');

  if (!baseline) {
    lines.push(
      'There is nothing to compare this against yet. `tewip agent --inventory` writes it to',
      `\`${at}\`; once that file is committed and somebody has read it, this section says what has changed`,
      'since, and `--gate` fails when something arrives that nobody approved.',
      '',
    );
    return lines;
  }

  const { added, removed } = changedSince(baseline, now);
  if (added.length === 0 && removed.length === 0) {
    lines.push(`Unchanged since the baseline of ${baseline.at.slice(0, 10)}, which was \`${hashOf(baseline.capabilities)}\`.`, '');
    return lines;
  }
  lines.push(`**Changed since the baseline of ${baseline.at.slice(0, 10)}** (\`${hashOf(baseline.capabilities)}\` to \`${now.hash}\`).`, '');
  for (const c of added) {
    const serious = c.reach && IRREVERSIBLE.includes(c.reach);
    lines.push(`- **new ${c.kind}**: \`${c.name}\`${c.reach ? ` — ${c.reach}` : ''}${serious ? ' — **and this one cannot be undone**' : ''}${c.file ? ` (${c.file})` : ''}`);
  }
  for (const c of removed) lines.push(`- gone: ${c.kind} \`${c.name}\`${c.reach ? ` — ${c.reach}` : ''}`);
  lines.push(
    '',
    'A capability arriving is not a finding on its own - somebody adds tools on purpose. It is here because',
    'the frameworks that ask for an agent registry are asking for exactly this: that nothing arrives without',
    'a person seeing it.',
    '',
  );
  return lines;
}
