// Applying a set of edits to a working tree, and being able to put everything back exactly as it
// was. Every step of building a feature is provisional until the tests say otherwise, so nothing
// here writes anything it cannot undo.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { mayChange } from '../autofix/code-target.ts';
import { changedLines } from '../autofix/code-fix.ts';
import type { FileEdit } from './build.ts';

export interface AppliedEdit extends FileEdit {
  /** Absolute path. */
  path: string;
  /** What the file held before, or null when Tewip created it. */
  was: string | null;
  changed: number;
}

export class Workspace {
  private readonly root: string;
  private readonly touched = new Map<string, string | null>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Remembers a file's contents the first time it is touched, so it can always be restored. */
  private remember(path: string): void {
    if (this.touched.has(path)) return;
    this.touched.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
  }

  write(path: string, content: string): void {
    this.remember(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }

  /** Everything back as it was: files restored, files Tewip created removed. */
  restore(): void {
    for (const [path, was] of this.touched) {
      if (was === null) rmSync(path, { force: true });
      else writeFileSync(path, was, 'utf8');
    }
    this.touched.clear();
  }

  /** Keeps the changes, and forgets how to undo them. */
  keep(): void {
    this.touched.clear();
  }

  /** What has been touched so far, for the report. */
  files(): string[] {
    return [...this.touched.keys()].map((p) => relative(this.root, p).split(sep).join('/'));
  }
}

export interface ApplyResult {
  applied: AppliedEdit[];
  /** Why an edit was refused, in words a person can act on. */
  refused: string[];
}

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);

/**
 * Applies a model's edits, refusing anything that is not allowed or does not match. Line endings
 * are compared in one form, because a Windows checkout and a model's answer never agree on them.
 */
export function applyEdits(workspace: Workspace, root: string, edits: FileEdit[], maxLines: number): ApplyResult {
  const applied: AppliedEdit[] = [];
  const refused: string[] = [];

  for (const edit of edits) {
    const path = resolve(root, edit.file);
    const rel = relative(resolve(root), path).split(sep).join('/');
    if (rel.startsWith('..') || resolve(path).startsWith('..')) {
      refused.push(`${edit.file} is outside the project`);
      continue;
    }
    const allowed = mayChange(path);
    if (!allowed.allowed) {
      refused.push(`${rel} may not be changed: ${allowed.why}`);
      continue;
    }

    const exists = existsSync(path);
    if (!exists) {
      if (edit.before.trim()) {
        refused.push(`${rel} does not exist, but the change expects text to already be in it`);
        continue;
      }
      workspace.write(path, edit.after);
      applied.push({ ...edit, path, was: null, changed: edit.after.split(NL).length });
      continue;
    }

    const raw = readFileSync(path, 'utf8');
    const crlf = raw.includes(CR + NL);
    const original = crlf ? raw.split(CR + NL).join(NL) : raw;
    const before = edit.before.split(CR + NL).join(NL);
    const after = edit.after.split(CR + NL).join(NL);

    if (!before.trim()) {
      refused.push(`${rel} already exists, so a change to it must say which text to replace`);
      continue;
    }
    const occurrences = original.split(before).length - 1;
    if (occurrences !== 1) {
      refused.push(`the text to replace in ${rel} ${occurrences === 0 ? 'is not in the file' : `appears ${occurrences} times`}`);
      continue;
    }
    const changed = original.replace(before, after);
    const touched = changedLines(original, changed);
    if (touched > maxLines) {
      refused.push(`the change to ${rel} touches ${touched} lines, which is a rewrite rather than a feature`);
      continue;
    }
    workspace.write(path, crlf ? changed.split(NL).join(CR + NL) : changed);
    applied.push({ ...edit, path, was: raw, changed: touched });
  }

  return { applied, refused };
}
