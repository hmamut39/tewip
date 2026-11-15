// Walking a project's files, once, for every command that needs to read them.
//
// It lived in secure/secrets.ts, where it was written, and `access` and `build` imported it from
// there - which is how the secret scanner's 5,000-file budget came to decide how much of a
// project the accessibility check reads. On n8n that meant 9 of 1,456 markup files reached the
// filter and none survived it, so `access` reported no barriers over a project it never opened.
//
// The cap now counts the files the caller actually wants. A budget spent on files the caller will
// discard is not a budget.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.tewip', '.next', '.cache']);
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|eot|mp4|mp3|wav|class|jar|pyc|lock)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The files git considers part of the project, or null when it cannot say.
 *
 * Phase 189. `tewip access` on a clone of the Flutter SDK read 268 markup files and reported 39
 * WCAG barriers, three of them blockers. The project has 25 markup files. The other 243 were under
 * `bin/cache/`, which is the downloaded Dart SDK - gitignored at `.gitignore:45`, absent from the
 * index, and not code anybody on that team can edit. Every blocker it named was in a dartdoc HTML
 * template inside that cache, cited against the WCAG criterion "a regulator would cite".
 *
 * `SKIP_DIR` above is the hand-maintained list that was supposed to prevent this, and it is the
 * same shape of thing that went stale for .NET and Dart in Phase 187: a list of other people's
 * directory names, which only ever covers the ones somebody thought of. Git already knows the
 * answer for every project, including the conventions nobody here has heard of.
 *
 * `--cached` keeps tracked files whatever the ignore rules say, and `--others
 * --exclude-standard` adds untracked files that are not ignored - a file a developer has written
 * and not yet committed is still theirs. On a fresh clone that is exactly the tracked set, so
 * nothing in the pinned corpus moves: there are no build artifacts in a repository nobody has
 * built.
 *
 * Null rather than empty when git is unavailable or this is not a repository. Those are different
 * answers, and treating "cannot ask" as "nothing belongs to the project" would read every file as
 * foreign and report nothing at all.
 */
export function projectFiles(root: string): Set<string> | null {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    const names = out.split(String.fromCharCode(0)).filter(Boolean);
    // Empty is null, not an empty set. Scanning a directory where git counts nothing - a path
    // entirely inside an ignored tree - must fall back to reading it rather than reporting a
    // project with no files. The tempting alternative, re-scanning whenever the filter leaves
    // nothing, is wrong: a repository that legitimately has no markup would then have its ignored
    // directories read, which is the Flutter defect coming back by another route.
    if (names.length === 0) return null;
    return new Set(names.map((n) => resolve(root, n)));
  } catch {
    return null;
  }
}

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
export function scanSourceFiles(root: string, limit: number = 5000, keep?: (path: string) => boolean, everything = false): FileScan {
  const out: string[] = [];
  let total = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // Sorted, so a capped scan reads the same files everywhere.
    //
    // `readdir` returns whatever order the filesystem gives, which differs between platforms. That
    // does not matter while everything is read - but `secrets` stops at 5,000 files on a large
    // project, and then the order decides *which* 5,000. n8n is over the cap, and its findings came
    // out as 34/21/13 on Windows and 33/18/15 on Linux from the same pinned commit: not a different
    // answer about the same files, a different set of files. A number that depends on the order the
    // filesystem happened to list a directory in is not reproducible, and a capped scan is exactly
    // where that shows.
    for (const entry of entries.sort()) {
      const path = join(dir, entry);
      let info;
      try {
        // `lstat`, not `stat`: a symlink must be seen as a symlink. See below.
        info = lstatSync(path);
      } catch {
        continue;
      }
      // A symlink is neither walked nor read.
      //
      // `stat` follows them, so a link to a directory looked like a directory and was walked. In
      // immich, `fastlane/metadata` points at `../mobile/android/fastlane/metadata` inside the same
      // repository: following it read 77 files a second time, under a path they do not really have.
      // A finding in one of them would have been reported twice, at two different paths, and the
      // file count no longer meant what the report said it meant.
      //
      // Worse than the double count: a link pointing out of the project would have Tewip reading
      // files outside the directory it was given, which it must never do whatever is on the other
      // end. Anything genuinely inside the project is still reached by its real path.
      //
      // Windows was already doing the right thing by accident - git writes a symlink there as a
      // small text file - which is exactly why this hid: the numbers were recorded on Windows and
      // only the Linux corpus run disagreed.
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!SKIP_DIR.has(entry)) walk(path);
        continue;
      }
      if (BINARY.test(entry) || info.size > MAX_FILE_BYTES) continue;
      // `keep` decides what counts, so the budget is spent on files the caller will read rather
      // than on everything that happens to be walked first.
      if (keep && !keep(path)) continue;
      // A file git does not count as part of the project is not part of the project. When git
      // cannot be asked, `belongs` is null and nothing is filtered - the old behaviour.
      if (belongs && !belongs.has(resolve(path))) continue;
      total += 1;
      if (out.length < limit) out.push(path);
    }
  };
  // `everything` is for the one caller that must not take git's word for it. See `secure`.
  const belongs = everything ? null : projectFiles(root);
  walk(root);
  return { files: out, total, capped: total > out.length };
}

/** Every text file the scan will read. Callers that need to know what it missed use `scanSourceFiles`. */
export const sourceFiles = (root: string, limit = 5000): string[] => scanSourceFiles(root, limit).files;
