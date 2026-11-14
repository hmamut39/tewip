// Does Tewip give the same answer about a file written on Windows as about the same file on Linux?
//
// It did not, and nothing had ever asked. Every workflow in this repository ran on ubuntu-latest
// until Phase 168 added a three-platform matrix; its first run failed on Windows, and the cause was
// not an exotic one. A CRLF file split on `\n` leaves `\r` at the end of every line, and in
// JavaScript `.` does not match `\r` - so `/^\s*cap_add\s*:(.*)$/` never matches a Windows compose
// file, the flag it sets is never set, and the `dangerous-capability` rule reports nothing at all.
//
// A rule that reports nothing is the worst way for this product to fail. The whole argument is that
// absence is not approval: a check that could not run says so. A rule that silently finds zero on
// every Windows checkout says "no dangerous capabilities here" in the only language a report has.
//
// So this measures it, per check, rather than auditing 40 call sites by eye. Each check gets a
// fixture project written twice - once with LF, once with CRLF - and the two answers are compared.
// Any check that answers differently is reading line endings as content.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHECK_RUNNERS, type CheckName } from '../engine/evidence/checks.ts';
import { FIXTURE } from './crlf-fixture.ts';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** One file in the fixture, written as a list of lines so the ending can be chosen per run. */

function write(root: string, eol: string): void {
  for (const f of FIXTURE) {
    const at = join(root, f.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, f.lines.join(eol) + eol, 'utf8');
  }
}

/**
 * A real audit chain, for `approvals`, which verifies each entry's hash and its link to the one
 * before it.
 *
 * Built here rather than by calling `record`, so that both trees get byte-identical text and
 * differ in exactly the thing under test. The first version did call `record` - in the LF tree,
 * then copied the file across - and the two answers differed because every entry stores the
 * project path it was recorded under, so the CRLF tree's log named the LF tree's directory. That
 * looked exactly like a line-ending bug in the hash chain and was a bug in this fixture.
 *
 * `project` is a fixed string for the same reason: a real path differs between the two temporary
 * directories, and it is covered by the hash, so it cannot simply be scrubbed afterwards.
 */
function auditChain(): string {
  const hashOf = (entry: unknown) => createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  let previous = '';
  const out: string[] = [];
  for (const [i, outcome] of ['read 9 files', 'found 2 things', 'wrote nothing'].entries()) {
    const body = {
      at: `2026-01-0${i + 1}T00:00:00.000Z`,
      who: 'fixture',
      command: 'infra',
      arguments: ['.'],
      project: '<fixture>',
      outcome,
      seconds: 1,
      previous,
    };
    const hash = hashOf(body);
    out.push(JSON.stringify({ ...body, hash }));
    previous = hash;
  }
  return out.join(LF) + LF;
}

/**
 * Commit the fixture, then take an endpoint out of the API description.
 *
 * Without this, `contracts` found nothing: `git show HEAD:<path>` fails in a directory that is not
 * a repository, so every description landed in `isNew` and the comparison that this check exists
 * for never ran. The tightened vacuity count in `entriesIn` is what surfaced that - the earlier
 * version counted JSON length and reported the empty answer as a finding.
 *
 * Identity is passed with `-c` rather than configured, because a CI runner has no git user and the
 * commit would fail. Returns false when git is not available, and the caller says so rather than
 * reporting a measurement it did not take.
 */
function commitAndBreak(root: string, eol: string): boolean {
  const run = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (run(['init', '-q']).status !== 0) return false;
  run(['add', '-A']);
  const committed = run(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'the api as it was']);
  if (committed.status !== 0) return false;
  // The second version, with `/orders/{id}` gone - a removed endpoint is the change `contracts`
  // is for, and it is the one a caller of the API would notice first.
  const after = FIXTURE.find((f) => f.path === 'api/openapi.yaml');
  if (!after) return false;
  const shorter = after.lines.slice(0, after.lines.indexOf('  /orders/{id}:'));
  writeFileSync(join(root, 'api', 'openapi.yaml'), shorter.join(eol) + eol, 'utf8');
  return true;
}

function writeAudit(root: string, eol: string): void {
  mkdirSync(join(root, '.tewip'), { recursive: true });
  writeFileSync(join(root, '.tewip', 'audit.jsonl'), auditChain().split(LF).join(eol), 'utf8');
}

export interface Parity {
  check: CheckName;
  /** JSON of the check's answer with LF files, and with CRLF files. */
  lf: string;
  crlf: string;
  agrees: boolean;
  /** How much the check found at all. A check finding nothing agrees with itself for free. */
  found: number;
  /** False when something the check needed was unavailable, so its agreement means less. */
  compared: boolean;
}

/**
 * How much a check actually found, counted as entries across every array in its answer.
 *
 * The first version of this used the length of the JSON for anything that was not itself an array,
 * so `approvals` - which returns an object - counted as "found something" on the strength of
 * `{"entries":[],"edited":[],"broken":[],"unreadable":[]}` being a non-empty string. The vacuity
 * half of this harness exists so that two checks finding nothing cannot agree for free, and for
 * one check it was doing the opposite of that.
 */
function entriesIn(value: unknown): number {
  if (Array.isArray(value)) return value.length + value.reduce<number>((n, v) => n + entriesIn(v), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((n, v) => n + entriesIn(v), 0);
  return 0;
}

/** The answer a check gives about one tree, as comparable text. Paths differ per run, so they go. */
function answer(check: CheckName, root: string): { text: string; found: number } {
  const raw = CHECK_RUNNERS[check]({ root });
  const text = JSON.stringify(raw ?? null)
    // The temp directory name is different between the two runs by construction.
    .split(JSON.stringify(root).slice(1, -1))
    .join('<root>')
    .split(root.split('\\').join('/'))
    .join('<root>');
  return { text, found: entriesIn(raw) };
}

export function measure(): Parity[] {
  const lfRoot = mkdtempSync(join(tmpdir(), 'tewip-parity-lf-'));
  const crlfRoot = mkdtempSync(join(tmpdir(), 'tewip-parity-crlf-'));
  try {
    write(lfRoot, LF);
    write(crlfRoot, CR + LF);
    writeAudit(lfRoot, LF);
    writeAudit(crlfRoot, CR + LF);
    const compared = commitAndBreak(lfRoot, LF) && commitAndBreak(crlfRoot, CR + LF);
    const out: Parity[] = [];
    for (const check of Object.keys(CHECK_RUNNERS) as CheckName[]) {
      const lf = answer(check, lfRoot);
      const crlf = answer(check, crlfRoot);
      out.push({ check, lf: lf.text, crlf: crlf.text, agrees: lf.text === crlf.text, found: lf.found, compared: check !== 'contracts' || compared });
    }
    return out;
  } finally {
    rmSync(lfRoot, { recursive: true, force: true });
    rmSync(crlfRoot, { recursive: true, force: true });
  }
}

function report(): void {
  const all = measure();
  const differ = all.filter((p) => !p.agrees);
  process.stdout.write(
    [
      '# the same file, written on Windows and on Linux',
      '',
      `${all.length} checks, each run over one fixture project written twice: once with LF endings, once with CRLF.`,
      '',
      `Checks that answer the same:      ${all.length - differ.length} of ${all.length}`,
      `Checks that answer differently:   ${differ.length}`,
      '',
      ...(all.some((p) => !p.compared)
        ? [`**Not fully compared**: ${all.filter((p) => !p.compared).map((p) => p.check).join(', ')} - something each needed was unavailable here, so its agreement says less.`]
        : []),
      '',
      '## Checks that read a line ending as content',
      '',
      ...(differ.length === 0
        ? ['None.']
        : differ.flatMap((p) => [
            `### \`${p.check}\``,
            '',
            `- with LF:   ${p.lf.length > 300 ? `${p.lf.slice(0, 300)}…` : p.lf}`,
            `- with CRLF: ${p.crlf.length > 300 ? `${p.crlf.slice(0, 300)}…` : p.crlf}`,
            '',
          ])),
      '',
      '---',
      '',
      'Why this matters more than a test failing: a rule that reads a line ending as content does not',
      'report an error, it reports nothing. This product argues that absence is not approval - that a',
      'check which could not run says so. A rule finding zero on every Windows checkout says "nothing',
      'here" in the only language a report has, to the people most likely to be running Windows.',
      '',
    ].join(LF),
  );
  if (differ.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
