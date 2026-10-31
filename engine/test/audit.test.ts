// Phase 137: who ran what, when, and whether the record has been edited since.
//
// An IT department buying a tool that touches source asks two things a README cannot answer:
// what has this actually done here, and can I trust the answer. The first needs a log; the second
// needs the log to be hard to quietly correct, which a plain file is not.
//
// Each line carries the hash of the line before it, so an entry that was changed, or removed from
// the middle, breaks every hash after it. What it does not survive is the whole file being
// deleted or lines cut from the end - and that is printed in the report rather than left for
// somebody to find out, because a tamper-evident log that oversells itself is worse than a plain
// one. Somebody relies on it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AUDIT_FILE, record, sanitise, verify } from '../audit/audit.ts';
import { renderAudit } from '../audit/audit-command.ts';

const NL = String.fromCharCode(10);
const project = (): string => mkdtempSync(join(tmpdir(), 'tewip-audit-'));
const lines = (root: string): string[] => readFileSync(join(root, AUDIT_FILE), 'utf8').split(NL).filter((l) => l.trim());
const rewrite = (root: string, ls: string[]) => writeFileSync(join(root, AUDIT_FILE), ls.join(NL) + NL, 'utf8');
const run = (root: string, command: string, args: string[] = []) => record(root, { command, arguments: args, outcome: 'ok', seconds: 0.1 });

describe('a credential never reaches the log', () => {
  it('drops the value after a secret flag, whether it is joined or separate', () => {
    assert.deepEqual(sanitise(['--token', 'hunter2', '--out', 'x.md']), ['--token', '--out', 'x.md']);
    assert.deepEqual(sanitise(['--api-key=abc123']), ['--api-key=(removed)']);
    assert.deepEqual(sanitise(['--password', 's3cret']), ['--password']);
  });

  it('keeps the flags that are not credentials, because a log of boxes helps nobody', () => {
    assert.deepEqual(sanitise(['--days', '30', '--out', 'report.md', '--gate']), ['--days', '30', '--out', 'report.md', '--gate']);
  });

  it('writes the sanitised form, not the original', () => {
    const root = project();
    run(root, 'secure', ['--token', 'hunter2']);
    assert.doesNotMatch(readFileSync(join(root, AUDIT_FILE), 'utf8'), /hunter2/);
  });
});

describe('the chain', () => {
  it('holds when nothing has been touched', () => {
    const root = project();
    run(root, 'sbom');
    run(root, 'infra');
    run(root, 'secure');
    const check = verify(root);
    assert.equal(check.entries.length, 3);
    assert.deepEqual([check.edited, check.broken, check.unreadable], [[], [], []]);
  });

  it('catches an entry changed after it was written', () => {
    const root = project();
    run(root, 'sbom');
    run(root, 'infra');
    run(root, 'secure');
    const ls = lines(root);
    const edited = JSON.parse(ls[1]) as { outcome: string };
    edited.outcome = 'ok (definitely)';
    ls[1] = JSON.stringify(edited);
    rewrite(root, ls);
    const check = verify(root);
    assert.deepEqual(check.edited, [2], 'the changed line is named, not merely "something is wrong"');
  });

  it('catches an entry removed from the middle', () => {
    const root = project();
    run(root, 'sbom');
    run(root, 'infra');
    run(root, 'secure');
    const ls = lines(root);
    ls.splice(1, 1);
    rewrite(root, ls);
    assert.deepEqual(verify(root).broken, [2]);
  });

  it('is not fooled by re-hashing the line that was edited', () => {
    // The obvious way to cover a track: change the entry and recompute its own hash. The line
    // then verifies against itself, and the line after it does not, because its `previous` still
    // points at the hash that used to be there. That is the whole reason for the chain.
    const root = project();
    run(root, 'sbom');
    run(root, 'infra');
    run(root, 'secure');
    const ls = lines(root);
    const entry = JSON.parse(ls[1]) as Record<string, unknown>;
    entry.outcome = 'ok (definitely)';
    delete entry.hash;
    ls[1] = JSON.stringify({ ...entry, hash: createHash('sha256').update(JSON.stringify(entry)).digest('hex') });
    rewrite(root, ls);
    const check = verify(root);
    assert.deepEqual(check.edited, [], 'the forged line verifies against itself');
    assert.deepEqual(check.broken, [3], 'and the one after it does not follow');
  });
});

describe('what the report says', () => {
  it('names what it cannot prove, including that deleting it works', () => {
    const root = project();
    run(root, 'sbom');
    const page = renderAudit(verify(root), false);
    assert.match(page, /the chain holds/);
    assert.match(page, /What this log does not prove/);
    assert.match(page, /does not survive being deleted/);
    assert.match(page, /lines are cut from the end/);
  });

  it('does not read an empty log as evidence that nothing ran', () => {
    const root = project();
    mkdirSync(join(root, '.tewip'), { recursive: true });
    const page = renderAudit(verify(root), false);
    assert.match(page, /Nothing is recorded yet/);
    assert.match(page, /not evidence that nothing ran/);
  });

  it('says plainly when the chain is broken, rather than printing the table and hoping', () => {
    const root = project();
    run(root, 'sbom');
    run(root, 'infra');
    const ls = lines(root);
    ls.splice(0, 1);
    rewrite(root, ls);
    assert.match(renderAudit(verify(root), false), /\*\*the chain does not hold\*\*/);
  });
});
