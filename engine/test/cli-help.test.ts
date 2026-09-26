// Every verb the command line answers has to be in the help, and the help has to survive being a
// template literal.
//
// Both halves are from real mistakes. A backtick was written into the help text to quote a flag,
// which ended the template literal and broke the build - caught only when packaging refused, after
// the commit had been pushed. And five verbs shipped across phases 15 to 19 that existed only if
// somebody already knew their names.
import assert from 'node:assert/strict';
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
