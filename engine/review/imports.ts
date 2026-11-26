// How a test says it uses a file, and whether that can be read at all.
//
// Split out of coverage.ts in Phase 217, when the measurement below took that file past this
// project's 300-line rule. These are the resolution rules: which language family a file belongs
// to, the names it can be imported by, whether a given source text imports it, and - the new
// one - whether an import in that language is something these patterns could ever match.
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Which language a file belongs to, for the one question that matters here: could a test written in
 * this language import that file at all?
 *
 * `importNames` reduces a file to its basename, so `lib/json_api_kit/url.rb` is looked for as
 * `url` - and discourse has 752 JavaScript test files, eight of which import something ending in
 * `url`. Every one of them was reported as **importing the Ruby file**, in the strongest wording
 * this project has: "Yes: 8 test file(s) reach it (imports it)". `plugins/discourse-post-voting/
 * plugin.rb` was covered by `uppy-checksum-plugin-test.js` on the same rule.
 *
 * A JavaScript file cannot import a Ruby one. Phase 217.
 */
const FAMILIES: Array<[RegExp, string]> = [
  [/\.(?:[cm]?[jt]sx?|vue|svelte)$/i, 'js'],
  [/\.py$/i, 'python'],
  [/\.rb$/i, 'ruby'],
  [/\.go$/i, 'go'],
  [/\.(?:java|kt|kts|scala|groovy)$/i, 'jvm'],
  [/\.(?:cs|fs)$/i, 'dotnet'],
  [/\.php$/i, 'php'],
  [/\.rs$/i, 'rust'],
  [/\.swift$/i, 'swift'],
  [/\.sql$/i, 'sql'],
];

export const familyOf = (file: string): string | null => FAMILIES.find(([p]) => p.test(file))?.[1] ?? null;

/** Folder names that are a place to put code, not a name code is imported by. */
const CONTAINER = new Set(['src', 'lib', 'source', 'sources', 'dist', 'build', 'out', 'esm', 'cjs', 'app']);

/**
 * The name the nearest package.json publishes, searching upward a few levels.
 *
 * A monorepo's packages are imported by their published name and by nothing else - immich's
 * `packages/sdk` is `@immich/sdk` everywhere it is used - so this is the only token that can
 * follow a change out of a package and into the code that consumes it.
 */
function publishedName(from: string): string | null {
  let dir = from;
  for (let up = 0; up < 4; up += 1) {
    try {
      const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name;
      if (name) return name;
    } catch {
      // No package.json here, or an unreadable one: keep going up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The module names a file can be imported by: its path, its name, and its folder's front door. */
export function importNames(root: string, changed: string): string[] {
  const full = resolve(root, changed);
  const noExt = full.slice(0, full.length - extname(full).length);
  const frontDoor = basename(noExt) === 'index' || basename(noExt) === '__init__';
  const names = new Set<string>([relative(root, noExt).split(sep).join('/')]);
  // `index` names a position, not a module, so it is never a name on its own.
  //
  // These tokens are matched as substrings inside a quoted import path, so a token has to identify
  // the file. `index` identifies every front door in the project. immich's
  // `packages/sdk/src/index.ts` contributed the bare token `index`, and 65 server specs that import
  // `src/schema/index.js` - a different file, in a different package - were reported as two hops
  // from a change to `packages/sdk/src/fetch-client.ts`. `tewip done` said 79 test files reached
  // that change. 15 do.
  //
  // The directory is what distinguishes one front door from another, so that is the token: the
  // specs above match `schema/index` for their own file and not `src/index` for this one. Phase 223.
  names.add(frontDoor ? `${basename(dirname(noExt))}/${basename(noExt)}` : basename(noExt));
  // Python: a.b.c for src/a/b/c.py, and the package it sits in.
  const parts = relative(root, noExt).split(sep).filter((p) => p !== 'src');
  names.add(parts.join('.'));
  // The folder a file sits in is not one of the names that file can be imported by - except in
  // Python, where `from a.b import c` names `c` through its package and is a real import of it.
  //
  // Everywhere else this made a folder import indistinguishable from a file import, in the
  // strongest of the three wordings: a test doing `import { base } from '../src/thing'` was
  // reported as importing `src/thing/base.js` by name. `packageNames` already answers that
  // question and answers it as the weaker kind, which is what it is. Phase 217.
  if (/\.py$/i.test(full)) names.add(parts.slice(0, -1).join('.'));
  if (frontDoor) {
    // The folder, unless the folder is a place to put code rather than a name for it. `src` as a
    // token matches any import path ending in `src`, which is 341 of immich's files and no more
    // informative than matching nothing; the package name below is what identifies that front door.
    const folder = basename(dirname(noExt));
    if (!CONTAINER.has(folder.toLowerCase())) names.add(folder);
    // What a package is imported by from outside itself, which is the only way to follow a change
    // across a package boundary. Without it the walk could not leave `packages/sdk` at all: it
    // missed all 18 immich specs that import `@immich/sdk` while reporting 65 that do not.
    const published = publishedName(dirname(noExt));
    if (published) names.add(published);
  }
  return [...names].filter((n) => n.length > 1);
}

/**
 * The package a changed file is re-exported from. In a project with one front door - which is most
 * libraries - every test imports "../src" and nothing imports "../src/utils.ts", so without this a
 * review finds no tests at all for a real change. Measured: 8 of 16 real commits were missed this
 * way before.
 */
export function packageNames(root: string, changed: string): string[] {
  const full = resolve(root, changed);
  const out: string[] = [];
  let dir = dirname(full);
  for (let up = 0; up < 3; up++) {
    for (const entry of ['index.ts', 'index.js', 'index.mjs', 'index.tsx', '__init__.py']) {
      const front = join(dir, entry);
      if (!existsSync(front)) continue;
      let source = '';
      try {
        source = readFileSync(front, 'utf8');
      } catch {
        continue;
      }
      const stem = basename(full).replace(/\.[^.]+$/, '');
      // Either it names this file, or it re-exports everything beside it.
      if (front !== full && (source.includes(stem) || /export\s+\*/.test(source))) {
        out.push(relative(root, dir).split(sep).join('/'), basename(dir));
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(out)].filter(Boolean);
}

/** Does this source import that file? Exported so the prover can follow imports further. */
export function importsIt(source: string, names: string[]): boolean {
  for (const name of names) {
    const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:from|import|require\\()\\s*['"][^'"]*${quoted}(?:\\.[cm]?[jt]sx?)?['"]`),
      new RegExp(`(?:^|\\n)\\s*(?:from\\s+${quoted}\\s+import|import\\s+${quoted})\\b`),
    ];
    if (patterns.some((p) => p.test(source))) return true;
  }
  return false;
}

/**
 * Whether an import of this file can be followed at all, which is not the same as whether it is
 * imported. Measured on the corpus, 25 source files sampled evenly through each repository:
 *
 * | language | repository       | test files | files whose imports resolved |
 * | -------- | ---------------- | ---------- | ---------------------------- |
 * | python   | dispatch         |         66 | 10 of 25                     |
 * | js       | immich           |        290 | 26 of 25 (several tests each) |
 * | jvm      | keycloak         |      1,958 | **0 of 25**                  |
 * | dotnet   | bitwarden-server |      1,173 | **0 of 25**                  |
 * | go       | gin              |         38 | **0 of 25**                  |
 * | ruby     | discourse        |        765 | **0 of 25**                  |
 *
 * `importsIt` looks for `from x`, `import x` and `require(x)`. C# writes `using Bit.Core;`, Go
 * imports a package and never a file, Java's `import org.keycloak.X` never equals a repo-relative
 * path, and Ruby's `require_relative "x"` is not `require("x")`. None of them can match, ever.
 *
 * So a zero for those languages is not evidence that nothing tests the file - it is this function
 * not being able to read that language's imports, and the two were being reported identically.
 * `src/Core/Constants.cs` was told **"no test imports or reaches it, and this change adds no test
 * either, so nothing here could notice a mistake in it"**; 63 of bitwarden's test files name the
 * types declared in that file. Phase 217.
 */
export const importsCanBeFollowed = (file: string): boolean => {
  const family = familyOf(file);
  return family === 'js' || family === 'python';
};
