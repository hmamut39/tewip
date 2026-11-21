// The corpus: real projects, pinned, with answers somebody checked by hand.
//
// Phase 43 shipped 166 false accusations against Keycloak - correct Java tests told they were
// worthless - and the only reason anybody found out is that the repository was cloned and 166 tests
// were read one at a time. Every test in this project passed before that and after it. A suite that
// cannot see its worst failure is not measuring the thing that matters.
//
// So the numbers that were verified by hand are written down here against a pinned commit, and this
// re-derives them. A number that moves is not automatically a bug - a real fix moves numbers, which
// is the point - but it has to be noticed and explained rather than discovered a phase later by a
// stranger. Each expectation carries how it was checked, because a number nobody verified is not
// evidence, it is just what the tool said that day.
//
// Nothing here is a fixture. These are other people's repositories at a known commit.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measure, type Command, type Expectation } from './corpus-measure.ts';

interface Check { command: Command; expect: Expectation; verified: string }
interface Repo { name: string; url: string; commit: string; why: string; checks: Check[] }

const MANIFEST = resolve('corpus/expected.json');
const CACHE = process.env.TEWIP_CORPUS ?? join(process.env.TEMP ?? '/tmp', 'tewip-corpus');

// maxBuffer, because `ls-files -s` over keycloak is 1.04 MB and the default is 1 MB: it threw
// ENOBUFS and printed a megabyte of file modes as the error.
const git = (args: string[], cwd?: string): string =>
  execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });

/** The repository at exactly that commit, cloned once and reused. */
function checkout(repo: Repo): string {
  const dir = join(CACHE, repo.name);
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    console.log(`  cloning ${repo.url}`);
    git(['clone', '--filter=blob:none', '--no-checkout', '--quiet', repo.url, dir]);
  }
  // `--depth 1` of a bare SHA needs the fetch, not the clone: a shallow clone only brings the tip.
  try {
    git(['fetch', '--quiet', '--depth', '1', 'origin', repo.commit], dir);
  } catch {
    git(['fetch', '--quiet', 'origin'], dir);
  }
  // Forced, because a previous run may have left files behind, and Windows refuses some paths.
  git(['checkout', '--quiet', '--force', repo.commit], dir);
  dropSymlinkStandIns(dir);
  return dir;
}

/**
 * Remove the files git writes in place of symlinks it could not create.
 *
 * Without this the corpus measures a different tree on each platform, and these numbers are
 * supposed to be the same number everywhere. On Linux git makes a real symlink, which the walker
 * skips. On Windows, without the privilege, git writes a small regular file whose contents are the
 * target path - and a regular file named `thing.ts` is read like any other, so Windows counted a
 * handful of files Linux did not.
 *
 * immich has one such entry, n8n twenty-five. The disagreement was 77 files before the walker
 * stopped following links and 1 to 10 after, which is how a platform difference looks when it is
 * nearly fixed: still a difference, and still enough to fail a verified number.
 *
 * Deleting them is right rather than convenient. On Linux these paths contribute nothing, because a
 * symlink is not walked; removing them on Windows makes the measured tree identical, and anything
 * genuinely in the repository is still there under its real path. Nothing is deleted outside the
 * corpus cache.
 */
function dropSymlinkStandIns(dir: string): void {
  for (const line of git(['ls-files', '-s'], dir).split(String.fromCharCode(10))) {
    // `<mode> <sha> <stage>\t<path>` - mode 120000 is a symlink.
    if (!line.startsWith('120000 ')) continue;
    const path = line.slice(line.indexOf(String.fromCharCode(9)) + 1);
    if (!path) continue;
    const full = join(dir, path);
    try {
      // Only when this platform did not make a real link: on Linux there is nothing to do.
      if (!lstatSync(full).isSymbolicLink()) rmSync(full, { force: true });
    } catch {
      continue;
    }
  }
}


const repos: Repo[] = JSON.parse(readFileSync(MANIFEST, 'utf8')).repos;
// The first argument that is not a flag. It used to be `process.argv[2]`, with `only === '--record'`
// special-cased beside it, so any second flag would have been read as a repository name and matched
// nothing - a run that checked **no repositories at all** and said "every number still holds".
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const record = process.argv.includes('--record');
/**
 * Report what moved and exit 0, because somebody asked rather than something broke.
 *
 * A moved number means "re-verify this by hand", and when the weekly run or a release tag says it,
 * failing is right - nobody asked, and a number that drifted unnoticed is the whole fear. But a
 * run dispatched by hand is a question, and answering a question with **"corpus: All jobs have
 * failed"** in somebody's inbox is a lie about what happened. Three of those went out in one
 * afternoon, every one of them a run I had asked for on purpose, and the owner could not tell them
 * from a broken build - which is exactly how a real red build ends up ignored.
 */
const asking = process.argv.includes('--asking');

// A name that matches nothing checked nothing and said so in the words of a clean run.
//
// `node scripts/corpus.ts nosuchrepo` printed **"Every number still holds"** and exited 0, having
// re-derived not one number. The dispatch input is a free-text box, so one typo bought a green run
// over 0 of 14 repositories - the exact shape this whole file exists to catch in Tewip, found in
// Tewip's own checker while writing the guard for something else.
const chosen = repos.filter((r) => !only || r.name === only);
if (chosen.length === 0) {
  console.error(`No repository here is called "${only}". The manifest has: ${repos.map((r) => r.name).join(', ')}.`);
  process.exit(1);
}
let moved = 0;

for (const repo of chosen) {
  console.log(`\n${repo.name}  ${repo.commit.slice(0, 10)}  - ${repo.why}`);
  const root = checkout(repo);
  for (const check of repo.checks) {
    const started = Date.now();
    const got = measure(check.command, root);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const keys = [...new Set([...Object.keys(check.expect), ...Object.keys(got)])].sort();
    const differences = keys.filter((k) => (check.expect[k] ?? 0) !== (got[k] ?? 0));
    if (differences.length === 0) {
      console.log(`  ${check.command.padEnd(7)} ok    ${seconds}s   ${keys.map((k) => `${k}=${got[k] ?? 0}`).join(' ')}`);
      continue;
    }
    moved += 1;
    console.log(`  ${check.command.padEnd(7)} MOVED ${seconds}s`);
    for (const k of differences) console.log(`    ${k}: expected ${check.expect[k] ?? 0}, got ${got[k] ?? 0}`);
    console.log(`    verified: ${check.verified}`);
    if (record) check.expect = got;
  }
}

if (record) {
  console.log('\n--record: writing the new numbers. Say in the commit why each one moved.');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const repo of manifest.repos)
    for (const [i, check] of repo.checks.entries()) {
      const measured = repos.find((r) => r.name === repo.name)?.checks[i];
      if (!measured) continue;
      // A key already written down stays written down, at zero if that is what it measures now.
      // `swallows-failure: 0` for Keycloak is the whole point of that entry - 166 of them shipped -
      // and dropping it because nothing matched would quietly remove the guard.
      check.expect = { ...Object.fromEntries(Object.keys(check.expect).map((k) => [k, 0])), ...measured.expect };
    }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
} else if (moved > 0) {
  console.log(`\n${moved} check(s) moved. A real fix moves numbers - re-verify by hand, then \`npm run corpus -- --record\`.`);
  if (asking) console.log('This run was dispatched by hand, so it is reporting rather than failing. The weekly run and a release tag still fail on a number that moved.');
  else process.exit(1);
} else {
  console.log('\nEvery number still holds.');
}
