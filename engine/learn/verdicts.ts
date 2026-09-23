// The LEARN step, everywhere.
//
// A person could already correct a diagnosis by replying under Tewip's own comment in CI, and Tewip
// answers with their decision from then on. Every other verdict it gives - this test should be
// quarantined, this secret is a real risk, the page has drifted from the design, this feature
// cannot be built here - had no such path, so the same argument had to be had again every week.
//
// This is that path, for all of them, and it keeps the properties that made the first one worth
// having: a correction is written by a person, it is stored with the project rather than inside
// Tewip, it says who and why, and **it never authorises an action on its own**. Deciding that a
// failure is a real bug does not make Tewip change code; deciding a flaky test is really broken
// does not make it un-quarantine anything. It changes what Tewip *says*, which is what a person
// was disagreeing with.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, readJsonl } from '../../reporters/store.ts';

/** Which kind of verdict is being corrected. */
export type VerdictKind = 'flaky' | 'security' | 'design' | 'build' | 'review';

export interface VerdictCorrection {
  schemaVersion: 1;
  kind: VerdictKind;
  /** What it is about: a test title, a file:line, a finding id. Matched exactly, case-insensitively. */
  key: string;
  /** The person's answer, in the words that kind of verdict uses. */
  verdict: string;
  reason: string;
  by: string;
  at: string;
  /** What Tewip had said, so the pair can become a labelled example later. */
  was?: string;
}

/** The words each kind accepts, so a typo is caught rather than stored and silently ignored. */
export const VERDICT_WORDS: Record<VerdictKind, string[]> = {
  flaky: ['quarantine', 'fix-now', 'watch', 'release'],
  security: ['real-risk', 'not-reachable', 'noise', 'accepted'],
  design: ['real', 'not-a-difference'],
  build: ['belongs-here', 'not-this-project'],
  review: ['covers', 'does-not-cover'],
};

export const VERDICTS_FILE = 'verdicts.jsonl';
const fileIn = (root: string) => join(root, '.tewip', VERDICTS_FILE);

export function loadVerdicts(root: string): VerdictCorrection[] {
  const path = fileIn(root);
  return existsSync(path) ? readJsonl<VerdictCorrection>(path) : [];
}

/** Adds one correction, replacing an earlier one about the same thing. */
export function saveVerdict(root: string, correction: Omit<VerdictCorrection, 'schemaVersion' | 'at'> & { at?: string }): VerdictCorrection {
  const entry: VerdictCorrection = { schemaVersion: 1, at: correction.at ?? new Date().toISOString(), ...correction };
  appendJsonl(fileIn(root), [entry]);
  return entry;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The person's answer about this thing, or null. The newest wins, so a team that changes its mind
 * simply says so again rather than editing a file.
 */
export function verdictFor(kind: VerdictKind, key: string, corrections: readonly VerdictCorrection[]): VerdictCorrection | null {
  const matching = corrections.filter((c) => c.kind === kind && (same(c.key, key) || key.toLowerCase().endsWith(c.key.trim().toLowerCase())));
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

/** What a corrected verdict is shown as, so nobody mistakes a person's decision for Tewip's. */
export function saidByAPerson(correction: VerdictCorrection): string {
  const when = correction.at.slice(0, 10);
  return `${correction.by} decided this on ${when}${correction.reason ? `: ${correction.reason}` : ''}`;
}

/** Whether a word is one this kind of verdict uses. */
export function isVerdictWord(kind: VerdictKind, word: string): boolean {
  return VERDICT_WORDS[kind].includes(word.trim().toLowerCase());
}

export function verdictHelp(): string {
  return [
    'Correct something Tewip said, and it will answer with your decision from now on:',
    '',
    '  tewip correct flaky "adds an item to the cart" fix-now "it is a real race, not flakiness"',
    '  tewip correct security "src/config.ts:12" noise "that is a sample key in a fixture"',
    '  tewip correct design "button Sign in" not-a-difference "we renamed it on purpose"',
    '  tewip correct build "an HTTP sink" belongs-here "this really is the right repository"',
    '',
    'The words each kind takes:',
    ...Object.entries(VERDICT_WORDS).map(([kind, words]) => `  ${kind.padEnd(9)} ${words.join(', ')}`),
    '',
    'A correction changes what Tewip says, never what it does on its own: it will not change code,',
    'quarantine a test or file a ticket because you corrected it.',
    'They are kept in .tewip/verdicts.jsonl, with the project, so the whole team shares them.',
  ].join('\n');
}
