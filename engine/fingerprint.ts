// What code a measured figure was measured against, so CI can notice when it has moved on.
//
// The accuracy figures in `measured.ts` are produced on a machine that has the labelled failures.
// Those failures are deliberately not in this repository - `.gitignore` says "collected triage data
// stays local", and the hand labels with them - so no CI job can re-derive a single one of them.
// That gap is why a headline figure was ten points high for seven weeks and nothing went red.
//
// Committing the corpus would close it and is not available: the decision to keep that data local is
// the project's, and it is deliberate. So this closes the half that can be closed without any data.
// A figure records the code it was measured against; CI recomputes that fingerprint from the source
// and fails when they differ. It cannot tell you the new figure - only the labelled data can do that
// - but it can refuse to let a stale one pass unnoticed, which is the failure that actually happened.
//
// What this does NOT catch, stated plainly so nobody reads more into a green run: a figure that
// drifts while the source stands still. The 93.4% claim drifted exactly that way - the rules were
// byte-identical and the model layer's behaviour had changed underneath them. That is the reason the
// published figures are rules-only, and the reason this guard is worth having for them: a
// deterministic layer cannot change its answers unless its code changes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { lf } from './lines.ts';

/** `from './x.ts'` and `from '../y/z.ts'`, in an import or a re-export. */
const FROM = /\bfrom\s*['"](\.[^'"]+\.ts)['"]/g;

/**
 * Every local source file reachable from `entry`, as repository-relative paths, sorted.
 *
 * Walked rather than listed. A hand-written list of "the files the rules depend on" would be right
 * on the day it was written and would quietly stop covering a new one - the same defect this
 * project found in its own channel checker a day earlier, where a check kept passing after it had
 * stopped looking at everything.
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
 * A hash of those files' contents.
 *
 * Line endings are normalised first. Without that the fingerprint is one value on the machine that
 * measured and another on a Windows checkout of the same commit, and the guard would fail for a
 * reason that has nothing to do with the figure - which is how a guard gets switched off.
 */
export function fingerprint(files: string[], root: string): string {
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update(lf(readFileSync(join(root, rel), 'utf8')));
  }
  return hash.digest('hex').slice(0, 16);
}

/** The entry point whose closure decides a rules-only diagnosis. */
export const RULES_ENTRY = 'engine/engine.ts';

export const rulesFingerprint = (root: string): { files: string[]; hash: string } => {
  const files = importClosure(RULES_ENTRY, root);
  return { files, hash: fingerprint(files, root) };
};
