// Running every check once over one repository, and keeping what each one said.
//
// The thing this file exists to get right is the failure case. Nine checks run here, and any of
// them can refuse: a lockfile Tewip cannot read, a git history with no previous version to compare
// against, a folder it has no permission to open. The tempting shape is a try/catch that logs and
// moves on, which produces a document with eight sections - and a reader has no way to tell the
// section that found nothing from the section that never ran. In a signed document that is the
// worst defect available: absence reading as approval, with a signature over it.
//
// So every check returns a `Part`, a part has either a result or a stated reason it has none, and
// the renderer is given no way to omit one quietly.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { findBarriers } from '../access/access-command.ts';
import type { AgentScan } from '../agent/scan.ts';
import type { AuditCheck } from '../audit/audit.ts';
import type { ContractScan } from '../contract/contract-command.ts';
import { ENGINE_VERSION } from '../engine.ts';
import { CHECK_RUNNERS, WHY_SKIPPED, type CheckName } from './checks.ts';
import { runChecks } from './run-checks.ts';
import type { IacScan } from '../iac/iac-command.ts';
import type { Inventory } from '../sbom/inventory.ts';
import type { imageContents } from '../sbom/sbom-command.ts';

import type { Migration } from '../schema/schema-command.ts';

import type { SecurityItem } from '../secure/triage.ts';
import type { Finding as AccessFinding } from '../access/checks.ts';

export interface Part<T> {
  /** What the check said, when it ran. */
  result?: T;
  /** Why there is nothing to report, when the check could not run. Never both. */
  refused?: string;
  seconds: number;
}

/** What the pack describes: a commit, or an answer about why it cannot name one. */
export interface Subject {
  commit?: string;
  /** Files changed but not committed. A pack built over these describes no commit at all. */
  dirty: string[];
  /** Why there is no commit, when there is none. */
  noGit?: string;
  /**
   * The repository this folder belongs to, when the folder is not its root.
   *
   * A pack about one package of a monorepo is a reasonable thing to want, and the commit it names
   * is the whole repository's. Saying so is the difference between that and a pack that appears to
   * cover everything the commit contains.
   */
  partOf?: string;
}

export type ImageContents = ReturnType<typeof imageContents>;
export type AccessResult = ReturnType<typeof findBarriers>;

export interface Evidence {
  project: string;
  root: string;
  /** ISO 8601, from the machine that ran it. */
  at: string;
  /** Tewip's own version, which is what a reader of the pack is being told about. */
  version: string;
  /** The rules-engine version, which is what makes a decision reproducible. */
  engine: string;
  subject: Subject;
  ships: Part<Inventory>;
  image: Part<ImageContents>;
  infra: Part<IacScan>;
  agent: Part<AgentScan>;
  access: Part<AccessResult>;
  secrets: Part<SecurityItem[]>;
  schema: Part<Migration[]>;
  contracts: Part<ContractScan>;
  approvals: Part<AuditCheck>;
  /** Findings a person wrote down as judged, which is the only approval Tewip can see. */
  accepted: Part<string[]>;
  /** How many threads the checks ran on, so the duration below can be read correctly. */
  threads: number;
  /** Why it ran on one thread, when workers could not be used. */
  fellBackBecause?: string;
  seconds: number;
}

export type { AccessFinding };

/** Runs one check, timing it, and turns any failure into a stated refusal. */
function part<T>(run: () => T): Part<T> {
  const began = Date.now();
  const took = () => Number(((Date.now() - began) / 1000).toFixed(1));
  try {
    return { result: run(), seconds: took() };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error), seconds: took() };
  }
}

/** A check deliberately not run, which is a different thing from a check that found nothing. */
const skipped = <T,>(what: string): Part<T> => ({
  refused: `not run, because --quick was given and ${what}. This is not a finding of nothing`,
  seconds: 0,
});

/**
 * Git, with its output left alone.
 *
 * This used to return `r.stdout.trim()`, which is right for `rev-parse` and quietly wrong for
 * `status --porcelain`: every porcelain line begins with a two-character status column and a space,
 * so trimming the whole output strips the leading space of the **first line only**. The first dirty
 * file in the pack came out as `li/args.ts`. One character, on one line, in the sentence that says
 * which commit the document does not describe.
 */
const git = (root: string, args: string[]): string | null => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout : null;
};

/** The product version, read from Tewip's own package.json rather than the project being scanned. */
function tewipVersion(): string {
  try {
    const pkg = readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8');
    return (JSON.parse(pkg) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Which commit this pack is about.
 *
 * A pack that names a commit while the working tree had uncommitted changes is a false statement
 * about a real artifact, and signing it makes the falsehood portable. So the dirty files are
 * collected and the renderer is required to say so before it names anything.
 *
 * Both git calls are scoped to the folder, which is not a detail. `git` walks *up* from its working
 * directory until it finds a repository, and this machine's home directory is itself one - so a
 * pack about any folder beneath it got `git status --porcelain` for the whole home directory and
 * listed `.bash_history`, `.claude.json` and every other dotfile as "differing from the commit".
 * Private filenames, in a document whose entire purpose is to be signed and sent to somebody
 * outside the company. `-- .` confines the answer to the folder being documented, and a scan of a
 * subfolder of a real repository - a package in a monorepo, which is a legitimate thing to ask for -
 * now names the repository it belongs to rather than silently presenting it as the whole subject.
 */
export function subjectOf(root: string): Subject {
  const toplevel = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!existsSync(resolve(root, '.git')) && !toplevel) {
    return { dirty: [], noGit: 'this folder is not a git repository, so the pack cannot name a commit' };
  }
  const commit = git(root, ['rev-parse', 'HEAD'])?.trim() || undefined;
  // Matched rather than sliced: `XY <path>`, and a rename is `XY <old> -> <new>`, whose new name
  // is the one that differs from the commit.
  const dirty = (git(root, ['status', '--porcelain', '--', '.']) ?? '')
    .split(String.fromCharCode(10))
    .map((l) => /^(..) (.*)$/.exec(l)?.[2]?.trim() ?? '')
    .map((f) => (f.includes(' -> ') ? f.split(' -> ')[1] : f))
    .map((f) => f.replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const partOf = toplevel && resolve(toplevel) !== resolve(root) ? toplevel : undefined;
  if (!commit) return { dirty, partOf, noGit: 'this repository has no commits yet, so the pack cannot name one' };
  return { commit, dirty, partOf };
}

export interface GatherOptions {
  root: string;
  /** The git ref API descriptions are compared against. */
  since?: string;
  /** Skip the checks that walk every source file, for a pack in seconds rather than a minute. */
  quick?: boolean;
  /** Run every check in this thread, for a measurement or a test that wants no workers. */
  serial?: boolean;
}

export async function gather(opts: GatherOptions): Promise<Evidence> {
  const began = Date.now();
  const root = resolve(opts.root);
  const quick = opts.quick ?? false;
  const names = Object.keys(CHECK_RUNNERS) as CheckName[];
  const only = quick ? names.filter((c) => !WHY_SKIPPED[c]) : names;

  const run = await runChecks({ job: { root, since: opts.since }, only, serial: opts.serial });
  const byName = new Map(run.ran.map((r) => [r.check, r]));
  const partOf = <T,>(check: CheckName): Part<T> => {
    const why = WHY_SKIPPED[check];
    if (quick && why) return skipped(why);
    const ran = byName.get(check);
    // A check the pool never reported is a refusal with a reason, never an absent section.
    if (!ran) return { refused: `this check did not report a result, and the pack cannot say why`, seconds: 0 };
    return ran.refused !== undefined ? { refused: ran.refused, seconds: ran.seconds } : { result: ran.result as T, seconds: ran.seconds };
  };

  return {
    project: basename(root) || root,
    root,
    at: new Date().toISOString(),
    version: tewipVersion(),
    engine: ENGINE_VERSION,
    subject: subjectOf(root),
    threads: run.threads,
    fellBackBecause: run.fellBackBecause,
    ships: partOf<Inventory>('ships'),
    image: partOf<ImageContents>('image'),
    infra: partOf<IacScan>('infra'),
    agent: partOf<AgentScan>('agent'),
    access: partOf<AccessResult>('access'),
    secrets: partOf<SecurityItem[]>('secrets'),
    schema: partOf<Migration[]>('schema'),
    contracts: partOf<ContractScan>('contracts'),
    approvals: partOf<AuditCheck>('approvals'),
    accepted: partOf<string[]>('accepted'),
    seconds: Number(((Date.now() - began) / 1000).toFixed(1)),
  };
}
