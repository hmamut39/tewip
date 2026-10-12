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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vouchAll } from '../engine/vouch/vouch-command.ts';
import { findBarriers } from '../engine/access/access-command.ts';
import { migrationsUnder, readMigration } from '../engine/schema/schema-command.ts';

interface Expectation { [key: string]: number }
interface Check { command: 'vouch' | 'schema' | 'access'; expect: Expectation; verified: string }
interface Repo { name: string; url: string; commit: string; why: string; checks: Check[] }

const MANIFEST = resolve('corpus/expected.json');
const CACHE = process.env.TEWIP_CORPUS ?? join(process.env.TEMP ?? '/tmp', 'tewip-corpus');

const git = (args: string[], cwd?: string): string =>
  execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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
  return dir;
}

/** Counts, derived from the engine rather than from the words of a report. */
function measure(command: Check['command'], root: string): Expectation {
  if (command === 'vouch') {
    // `['.']` is what the CLI passes when nobody names a path, and `vouchAll` does its own walking -
    // handing it the walked list again would join absolute paths onto the root a second time.
    const files = vouchAll(root, ['.']);
    const out: Expectation = { files: files.length, tests: 0 };
    for (const file of files)
      for (const judgement of file.judgements) {
        out.tests += 1;
        out[judgement.verdict] = (out[judgement.verdict] ?? 0) + 1;
      }
    return out;
  }
  if (command === 'access') {
    const { findings, filesRead } = findBarriers(root);
    const out: Expectation = { filesRead, findings: findings.length };
    for (const f of findings) out[f.confidence] = (out[f.confidence] ?? 0) + 1;
    return out;
  }
  const files = migrationsUnder(root);
  const out: Expectation = { filesRead: 0, findings: 0 };
  for (const file of files) {
    const migration = readMigration(root, file);
    if (migration.unread) continue;
    out.filesRead += 1;
    for (const f of migration.findings) {
      out.findings += 1;
      out[f.risk] = (out[f.risk] ?? 0) + 1;
    }
  }
  return out;
}

const repos: Repo[] = JSON.parse(readFileSync(MANIFEST, 'utf8')).repos;
const only = process.argv[2];
const record = process.argv.includes('--record');
let moved = 0;

for (const repo of repos.filter((r) => !only || only === '--record' || r.name === only)) {
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
  process.exit(1);
} else {
  console.log('\nEvery number still holds.');
}
