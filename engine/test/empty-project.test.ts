// Phase 83: every command, handed a project with nothing in it, must say what is missing.
//
// This is the fourth time the same bug has been found one instance at a time. `recall` searched an
// empty index and reported "Searched 1305 kept failure(s)" (59). The safety harness measured nothing
// and reported zero tests lost (73). `design` could not see a number and reported no change (80).
// The risk digest compared a window with itself and reported that nothing got worse (82). Each was
// a clean answer produced by having looked at nothing, and each was found by stumbling into it.
//
// So the audit stops being a thing somebody remembers to do. Every command that reads project state
// is run here against an empty directory, and the answer has to name the emptiness. A count of zero
// is not a finding; "I found nothing to look at" is.
//
// What this cannot check is whether the explanation is *good* - only that one is given. It is a
// floor, not a ceiling.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../reporters/store.ts';

const CLI = join(PROJECT_ROOT, 'cli', 'tewip.ts');

function emptyProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-empty-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'nothing', version: '1.0.0', type: 'module' }), 'utf8');
  return root;
}

/** Runs a command in `root` and returns everything it said, however it exited. */
function run(root: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/**
 * Words that name an absence. A command answering an empty project has to use one: it is the
 * difference between "I looked and found nothing wrong" and "there was nothing to look at".
 */
const NAMES_THE_ABSENCE = new RegExp(
  [
    'no (?:run|history|plan|test file|markup file|report|barrier)',
    'nothing (?:has been kept|to attest|yet|to compare|here to|in this|changed in)',
    'has taught Tewip nothing',
    'nobody has corrected',
    'was read, so nothing',
    'could not read',
    // "Is this a git checkout?" is this project naming the absence in its own words, and the first
    // version of this pattern missed it - the test was wrong, not `done`.
    'is this a git checkout',
    'found none',
  ].join('|'),
  'i',
);

/** A claim that would be a lie about an empty project. */
const SOUNDS_LIKE_A_PASS = /nothing here is unable to fail|no area got noticeably worse|everything passed|all checks passed/i;

const COMMANDS: Array<{ name: string; args: string[] }> = [
  { name: 'note', args: ['note', '--days', '30'] },
  { name: 'learn', args: ['learn'] },
  { name: 'trace', args: ['trace'] },
  { name: 'standards', args: ['standards'] },
  { name: 'vouch', args: ['vouch'] },
  { name: 'attest', args: ['attest'] },
  { name: 'flaky', args: ['flaky'] },
  { name: 'recall', args: ['recall', 'some error nobody has seen'] },
  { name: 'pursue', args: ['pursue', 'keep it green'] },
  { name: 'pick', args: ['pick'] },
  { name: 'review', args: ['review'] },
  { name: 'done', args: ['done'] },
];

describe('what every command says when there is nothing to look at', () => {
  for (const { name, args } of COMMANDS) {
    it(`${name} names what is missing rather than reporting zeros`, () => {
      const said = run(emptyProject(), args);
      assert.ok(said.trim().length > 0, `${name} said nothing at all`);
      assert.match(said, NAMES_THE_ABSENCE, `${name} must say what it did not find:\n${said.slice(0, 400)}`);
      assert.doesNotMatch(said, SOUNDS_LIKE_A_PASS, `${name} read nothing and reported a pass:\n${said.slice(0, 400)}`);
    });
  }

  it('does not leak a tool’s own error ahead of its explanation', () => {
    // `execFileSync` sends a child's stderr straight to the parent unless told not to, so three
    // commands printed git's `fatal: ambiguous argument` and a git usage hint before saying, in
    // their own words, that this is not a git checkout. The failure was handled; it looked like a
    // crash.
    const root = emptyProject();
    for (const command of [['pick'], ['review'], ['done']]) {
      const said = run(root, command);
      assert.doesNotMatch(said, /fatal: ambiguous argument/, `${command[0]} leaked git's error`);
      assert.doesNotMatch(said, /Use '--' to separate paths from revisions/, `${command[0]} leaked git's usage hint`);
      assert.match(said, /^tewip:/m, `${command[0]} should answer in its own voice`);
    }
  });
});
