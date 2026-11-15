// What code a measured figure was measured against, so CI can notice when it has moved on.
//
// The accuracy figures in `engine/measured.ts` are produced on a machine that has the labelled
// failures. Those failures are deliberately not in this repository - `.gitignore` says "collected
// triage data stays local", and the hand labels with them - so no CI job can re-derive a single one
// of them. That gap is why a headline figure was ten points high for seven weeks and nothing went
// red. Committing the corpus is not available: keeping that data local is the project's decision
// and a deliberate one. So this closes the half that can be closed without any data. A figure
// records the code it was measured against; CI recomputes that fingerprint and fails when they
// differ.
//
// It hashes **what the code does, not how it reads**. Phase 182 changed four lines of comment
// inside the rules closure and turned the guard red, which cost three harness runs to clear - and
// all three confirmed the figures unchanged, as a comment cannot do otherwise. That is a guard
// people learn to satisfy from memory, which is the exact failure Phase 180 was about: the remedy
// for a red guard has to be cheap enough that nobody is tempted to shortcut it.
//
// So each file is put through Node's own `stripTypeScriptTypes` in `transform` mode, and the
// JavaScript that comes out is what gets hashed. The safety property is the parser's, not a
// regex's: two files that produce identical JavaScript behave identically at runtime, and the
// parser is the thing that definitionally knows a `//` inside a string literal from a comment. A
// hand-written stripper is where this would go wrong, which is why there isn't one. The TypeScript
// compiler would have done as well, but this project is on TypeScript 7, whose JavaScript API
// exposes `version` and nothing else.
//
// What it still does NOT catch, stated plainly so a green run is not over-read: a figure that
// drifts while the code stands still. The 93.4% claim drifted exactly that way - the rules were
// byte-identical and the model layer's behaviour had changed underneath them. That is the reason
// the published figures are rules-only, and the reason this guard is worth having for them: a
// deterministic layer cannot change its answers unless its code changes.
//
// This lives under `eval/` rather than `engine/` on purpose. `stripTypeScriptTypes` is an
// experimental Node API and warns when it is first called; everything under `engine/` is compiled
// into `dist/` and published, and a published command that printed an experimental-API warning on
// every run would be making the user pay for a measurement they are not taking.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { lf } from '../engine/lines.ts';

/** `from './x.ts'` and `from '../y/z.ts'`, in an import or a re-export. */
const FROM = /\bfrom\s*['"](\.[^'"]+\.ts)['"]/g;

/**
 * Every local source file reachable from `entry`, as repository-relative paths, sorted.
 *
 * Walked rather than listed. A hand-written list of "the files the rules depend on" would be right
 * on the day it was written and would quietly stop covering a new one - the defect this project
 * found in its own channel checker in Phase 176, where a check kept passing after it had stopped
 * looking at everything.
 */
export function importClosure(entry: string, root: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = relative(root, file).split('\\').join('/');
    if (seen.has(rel)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // A path that does not resolve is left out rather than guessed at. It cannot be a file whose
      // contents decide an answer, because it does not exist to be read.
      continue;
    }
    seen.add(rel);
    for (const m of text.matchAll(FROM)) queue.push(resolve(dirname(file), m[1]));
  }
  return [...seen].sort();
}

/**
 * The JavaScript a source file reduces to, with comments and types gone.
 *
 * On a file the parser cannot read this returns the source unchanged. That is the safe direction:
 * an unreadable file keeps its raw text in the hash, so the guard still fires on any edit to it,
 * and the alternative - returning something constant - would make every broken file agree with
 * every other broken file.
 */
export function behaviourOf(source: string): string {
  try {
    // `transform` is cast in because the bundled @types/node still types `mode` as `'strip'`
    // alone. The runtime accepts it - `strip` only blanks the types and leaves every comment in
    // place, which would defeat the whole point of this file - and the fallback below covers the
    // day that stops being true.
    const out = stripTypeScriptTypes(source, { mode: 'transform' as 'strip' });
    return typeof out === 'string' && out.length > 0 ? out : source;
  } catch {
    return source;
  }
}

/**
 * A hash of what those files do.
 *
 * Line endings are normalised before the compiler sees them. Without that the same commit
 * fingerprints one way on the machine that measured and another on a Windows checkout, the guard
 * fails for a reason that has nothing to do with any figure, and a guard that cries wolf on
 * checkout alone is one somebody switches off.
 */
export function fingerprint(files: string[], root: string): string {
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update(behaviourOf(lf(readFileSync(join(root, rel), 'utf8'))));
  }
  return hash.digest('hex').slice(0, 16);
}

/** The entry point whose closure decides a rules-only diagnosis. */
export const RULES_ENTRY = 'engine/engine.ts';

export const rulesFingerprint = (root: string): { files: string[]; hash: string } => {
  const files = importClosure(RULES_ENTRY, root);
  return { files, hash: fingerprint(files, root) };
};
