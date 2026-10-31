// Walking a project's files, once, for every command that needs to read them.
//
// It lived in secure/secrets.ts, where it was written, and `access` and `build` imported it from
// there - which is how the secret scanner's 5,000-file budget came to decide how much of a
// project the accessibility check reads. On n8n that meant 9 of 1,456 markup files reached the
// filter and none survived it, so `access` reported no barriers over a project it never opened.
//
// The cap now counts the files the caller actually wants. A budget spent on files the caller will
// discard is not a budget.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.tewip', '.next', '.cache']);
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|eot|mp4|mp3|wav|class|jar|pyc|lock)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface FileScan {
  /** The files that will be read, up to the limit. */
  files: string[];
  /** Every file that qualified, including the ones past the limit. */
  total: number;
  /** True when the limit stopped it short, so `files` is not the project. */
  capped: boolean;
}

/**
 * The text files in a project, skipping what no repository owns - and how many there really are.
 *
 * The count is the point. This used to stop at the limit and say nothing, and `sourceFiles` was
 * documented as "every text file in a project", which it is not once the limit bites. On
 * discourse that meant reading 5,000 of 26,472 files, finding nothing, and reporting "secrets in
 * the working tree" as checked - a clean answer about 19% of a repository, in the one report
 * where a clean answer is worth the most and justified the least.
 *
 * Walking the rest costs a readdir and a stat per file, which is a second or so on the largest
 * project in the corpus. Knowing that the answer is partial is worth a second.
 */
export function scanSourceFiles(root: string, limit: number = 5000, keep?: (path: string) => boolean): FileScan {
  const out: string[] = [];
  let total = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIR.has(entry)) walk(path);
        continue;
      }
      if (BINARY.test(entry) || info.size > MAX_FILE_BYTES) continue;
      // `keep` decides what counts, so the budget is spent on files the caller will read rather
      // than on everything that happens to be walked first.
      if (keep && !keep(path)) continue;
      total += 1;
      if (out.length < limit) out.push(path);
    }
  };
  walk(root);
  return { files: out, total, capped: total > out.length };
}

/** Every text file the scan will read. Callers that need to know what it missed use `scanSourceFiles`. */
export const sourceFiles = (root: string, limit = 5000): string[] => scanSourceFiles(root, limit).files;
