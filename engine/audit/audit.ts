// Who ran what, when, and whether the record has been edited since.
//
// An IT department buying a tool that touches source asks two questions a README cannot answer:
// what has this thing actually done here, and can I trust the answer. The first needs a log. The
// second needs the log to be hard to quietly correct, which a plain file is not.
//
// So each line carries the hash of the line before it. Changing an entry, or removing one from
// the middle, breaks every hash after it and `tewip audit` says exactly where. What it does NOT
// do is survive the whole file being deleted, or lines being removed from the end, and that is
// written into the report rather than left for somebody to discover - a tamper-evident log that
// oversells itself is worse than a plain one, because somebody relies on it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';

export interface AuditEntry {
  /** ISO 8601, from the machine that ran it. */
  at: string;
  /** The person or the automation. Never looked up anywhere; read from the environment. */
  who: string;
  /** The verb, e.g. `secure`. */
  command: string;
  /** The flags, with any value that could be a credential removed. */
  arguments: string[];
  /** Where it ran. */
  project: string;
  /** How it ended: `ok`, or a one-line reason. */
  outcome: string;
  seconds: number;
  /** sha256 of the entry before this one, or '' for the first. */
  previous: string;
  /** sha256 of this entry, with `hash` itself left out. */
  hash: string;
}

export const AUDIT_FILE = join('.tewip', 'audit.jsonl');

/**
 * Flags whose value is a credential, and must never reach the log.
 *
 * The log is the one file in this project that is *designed* to be read by somebody other than
 * the person who ran the command, so writing a token into it is worse here than anywhere else.
 * Unknown flags keep their value, because a log of `--out ████` helps nobody; flags are listed by
 * name rather than guessed at by shape.
 */
const SECRET_FLAG = /^--(token|key|secret|password|pass|auth|api-key|pat)$/i;

export function sanitise(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [name, inline] = arg.split('=', 2);
    if (SECRET_FLAG.test(name)) {
      out.push(inline === undefined ? name : `${name}=(removed)`);
      // `--token abc` puts the value in the next argument, and it must go too.
      if (inline === undefined && args[i + 1] && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const hashOf = (entry: Omit<AuditEntry, 'hash'>): string => createHash('sha256').update(JSON.stringify(entry)).digest('hex');

/** The last line's hash, so the next entry can chain onto it. */
export function lastHash(root: string): string {
  const path = join(root, AUDIT_FILE);
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean);
  if (lines.length === 0) return '';
  try {
    return (JSON.parse(lines[lines.length - 1]) as AuditEntry).hash ?? '';
  } catch {
    return '';
  }
}

export function record(root: string, what: { command: string; arguments: string[]; outcome: string; seconds: number }): AuditEntry {
  const body: Omit<AuditEntry, 'hash'> = {
    at: new Date().toISOString(),
    // CI first: on a runner the OS user is `runner`, which identifies nobody.
    who: process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.BUILD_REQUESTEDFOR ?? safeUser(),
    command: what.command,
    arguments: sanitise(what.arguments),
    project: root,
    outcome: what.outcome,
    seconds: Number(what.seconds.toFixed(2)),
    previous: lastHash(root),
  };
  const entry: AuditEntry = { ...body, hash: hashOf(body) };
  const path = join(root, AUDIT_FILE);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}${String.fromCharCode(10)}`, 'utf8');
  return entry;
}

function safeUser(): string {
  try {
    return userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface AuditCheck {
  entries: AuditEntry[];
  /** Line numbers, 1-based, whose hash does not match their contents. */
  edited: number[];
  /** Line numbers whose `previous` does not match the line before: something was removed. */
  broken: number[];
  unreadable: number[];
}

export function verify(root: string): AuditCheck {
  const path = join(root, AUDIT_FILE);
  const out: AuditCheck = { entries: [], edited: [], broken: [], unreadable: [] };
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, 'utf8').split(String.fromCharCode(10)).filter((l) => l.trim());
  let expected = '';
  for (const [i, line] of lines.entries()) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      out.unreadable.push(i + 1);
      continue;
    }
    out.entries.push(entry);
    const { hash, ...body } = entry;
    if (hashOf(body) !== hash) out.edited.push(i + 1);
    if (entry.previous !== expected) out.broken.push(i + 1);
    expected = hash;
  }
  return out;
}
