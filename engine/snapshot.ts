// Reads the page snapshot Playwright stores in error-context.md when a test fails.
// It is an ARIA snapshot (roles + accessible names), captured at the moment of failure.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { PROJECT_ROOT } from '../reporters/store.ts';
import type { TriageRecord } from '../reporters/types.ts';

export interface SnapshotElement {
  role: string;
  /** Accessible name, e.g. the button label. */
  name: string;
  /** Inline text content after the colon, e.g. a paragraph's text. */
  text: string;
  /** Snapshot ref (e1, e2, ...), useful to point a later fix step at the element. */
  ref?: string;
}

/** Absolute path of the record's error-context.md, or null if it no longer exists. */
export function errorContextPath(record: TriageRecord): string | null {
  const direct = record.attachments.find((a) => a.name === 'error-context')?.path;
  // Records collected before the reporter kept this attachment: it sits next to the trace.
  const first = record.attachments[0]?.path;
  const sibling = first ? posix.join(posix.dirname(first), 'error-context.md') : undefined;
  for (const rel of [direct, sibling]) {
    if (rel && existsSync(join(PROJECT_ROOT, rel))) return join(PROJECT_ROOT, rel);
  }
  return null;
}

export function readPageSnapshot(record: TriageRecord): SnapshotElement[] | null {
  const file = errorContextPath(record);
  if (!file) return null;
  return extractPageSnapshot(readFileSync(file, 'utf8'));
}

/** Pulls the "# Page snapshot" yaml block out of an error-context.md document. */
export function extractPageSnapshot(markdown: string): SnapshotElement[] | null {
  const yaml = markdown.match(/# Page snapshot\s*```yaml\r?\n([\s\S]*?)```/)?.[1];
  return yaml === undefined ? null : parseAriaSnapshot(yaml);
}

// - role "name" [attr] [ref=e1]: text
const LINE = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)\s*(?::\s*(.*))?$/;

export function parseAriaSnapshot(yaml: string): SnapshotElement[] {
  const elements: SnapshotElement[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, role, name = '', attrs = '', text = ''] = m;
    elements.push({ role, name: unquote(`"${name}"`), text: unquote(text.trim()), ref: attrs.match(/\[ref=([^\]]+)\]/)?.[1] });
  }
  return elements;
}

function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}
