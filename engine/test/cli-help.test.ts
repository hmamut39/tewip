// Every verb the command line answers has to be in the help, and the help has to survive being a
// template literal.
//
// Both halves are from real mistakes. A backtick was written into the help text to quote a flag,
// which ended the template literal and broke the build - caught only when packaging refused, after
// the commit had been pushed. And five verbs shipped across phases 15 to 19 that existed only if
// somebody already knew their names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HELP } from '../../cli/help.ts';

const cli = readFileSync(join(import.meta.dirname, '..', '..', 'cli', 'tewip.ts'), 'utf8');
const work = readFileSync(join(import.meta.dirname, '..', '..', 'cli', 'verbs-work.ts'), 'utf8');

/** Every `case 'verb':` the command line dispatches, minus the flags and aliases. */
const verbs = [...`${cli}${work}`.matchAll(/case '([a-z-]+)':/g)]
  .map((m) => m[1])
  .filter((v) => !['help', 'mcp'].includes(v) && !v.startsWith('-'));

describe('the command line and its help', () => {
  it('documents every verb it answers', () => {
    const missing = [...new Set(verbs)].filter((verb) => !new RegExp(`\\btewip ${verb}\\b`).test(HELP));
    assert.deepEqual(missing, [], `these verbs work but are in no help text, so nobody will find them: ${missing.join(', ')}`);
  });

  it('answers at least the verbs this project has shipped', () => {
    for (const verb of ['explain', 'plan', 'write', 'review', 'flaky', 'secure', 'attest', 'incident', 'recall', 'trace', 'pursue']) {
      assert.ok(verbs.includes(verb), `${verb} is no longer dispatched by the command line`);
    }
  });

  it('holds no backtick, which would end the template literal it lives in', () => {
    assert.ok(!HELP.includes('`'), 'a backtick in the help text ends the string and breaks the build');
  });

  it('reads as help rather than as a wall', () => {
    const lines = HELP.split(String.fromCharCode(10));
    const tooWide = lines.filter((l) => l.length > 110);
    assert.deepEqual(tooWide, [], `these lines will wrap in a terminal: ${tooWide.slice(0, 2).join(' | ')}`);
  });
});

// Phase 122: what the answer cost, on every verb.
//
// Twelve of the thirty-five verbs printed a cost line; the rest left the reader to assume, and
// the silent ones are mostly the ones that cost nothing - exactly backwards. A tool that runs a
// model over every pull request cannot print "$0.00", and Tewip was hiding its best line on the
// commands that earn it.
//
// Printed once at the end of the process rather than in each verb, because thirty-five copies of
// a sentence drift apart and the next verb added would quietly not have one. These tests run the
// real binary, because the point is the behaviour a user sees, not the presence of a function.
describe('the cost line', () => {
  const run = (...args: string[]): { out: string; err: string } => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'cli', 'tewip.ts'), ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  it('says a rules-only answer cost nothing, on a verb that never printed it before', () => {
    const { err } = run('vouch', join(import.meta.dirname, 'cli-help.test.ts'));
    assert.match(err, /This answer cost \$0\.00/);
    assert.match(err, /no model was called/);
  });

  it('keeps it out of the report itself, so a piped file stays clean', () => {
    const { out } = run('vouch', join(import.meta.dirname, 'cli-help.test.ts'));
    assert.doesNotMatch(out, /This answer cost/, 'stdout is the report; the cost belongs on stderr');
  });

  it('stays quiet for help and version, which answer nothing and cost nothing', () => {
    for (const verb of ['--help', '--version']) {
      const { out, err } = run(verb);
      assert.doesNotMatch(`${out}${err}`, /This answer cost/, `${verb} should not report a cost`);
    }
  });

  it('is printed from one place, not copied into each verb', () => {
    // The guard that keeps it from drifting: if someone starts pasting it per-verb, this fails.
    assert.equal((cli.match(/usageLine\(\)/g) ?? []).length, 1, 'cli/tewip.ts should call usageLine exactly once');
  });
});
