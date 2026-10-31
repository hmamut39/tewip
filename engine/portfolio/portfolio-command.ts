// `tewip portfolio <folder>`: run the local checks over every checkout under it, once.
//
// Each check is the same code the single-repository command runs, called directly rather than
// shelled out to, so a number here and a number there cannot drift. A check that throws is
// recorded as "could not run" with the reason, because one repository without a lockfile must not
// take the page down, and a crash that quietly becomes a zero is the failure this file is built
// against.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { scanSecrets } from '../secure/secrets.ts';
import { triageSecret } from '../secure/triage.ts';
import { scanSourceFiles } from '../walk.ts';
import { flows } from '../taint/flow.ts';
import { scanIac } from '../iac/iac-command.ts';
import { inventory } from '../sbom/inventory.ts';
import { NEEDS_A_LOOK } from '../sbom/licences.ts';
import { findBarriers } from '../access/access-command.ts';
import { migrationsUnder, readMigration } from '../schema/schema-command.ts';
import { vouchAll } from '../vouch/vouch-command.ts';
import { CHECKS, renderPortfolio, type Cell, type Check, type RepoRow } from './portfolio.ts';

export interface PortfolioCommand {
  root: string;
  out?: string;
  /** Skip the slow one. `vouch` reads every test in the project and dominates the run. */
  quick?: boolean;
}

const ran = (count: number, detail: string): Cell => ({ ran: true, count, detail });
const JS = /\.(?:[cm]?[jt]sx?)$/;

/** Directories under `root` that look like a checkout. */
export function checkoutsUnder(root: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    // A checkout is a folder with a .git in it, or failing that one that holds source at all.
    if (existsSync(join(full, '.git')) || existsSync(join(full, 'package.json')) || existsSync(join(full, 'pyproject.toml'))) found.push(full);
  }
  return found.sort();
}

/** One check, with anything it throws turned into a reason rather than a stack trace. */
function attempt(what: () => Cell): Cell {
  try {
    return what();
  } catch (error) {
    return { ran: false, why: `the check failed here: ${error instanceof Error ? error.message.split(String.fromCharCode(10))[0].slice(0, 120) : 'unknown'}` };
  }
}

export function examine(path: string, quick = false): RepoRow {
  const started = Date.now();
  const cells: Record<string, Cell> = {};

  cells.secrets = attempt(() => {
    const files = scanSourceFiles(path).files;
    const found = scanSecrets(path, files);
    const risky = found.filter((f) => triageSecret(f, path, new Set<string>()).verdict === 'real-risk');
    return ran(risky.length, `${found.length} shape(s) matched, ${risky.length} need action`);
  });

  cells.injection = attempt(() => {
    const files = scanSourceFiles(path, 20_000, (f) => JS.test(f) && !/\.(?:test|spec)\./.test(f)).files;
    let n = 0;
    for (const file of files) {
      let source = '';
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      n += flows(relative(path, file), source).length;
    }
    return files.length === 0 ? { ran: false, why: 'no JavaScript or TypeScript here to follow a value through' } : ran(n, `${files.length} file(s) read`);
  });

  cells.containers = attempt(() => {
    const scan = scanIac(path);
    if (scan.dockerfiles + scan.composeFiles === 0) return { ran: false, why: 'no Dockerfile or compose file here' };
    return ran(scan.findings.filter((f) => f.ships && f.risk === 'high').length, `${scan.dockerfiles} Dockerfile(s), ${scan.composeFiles} compose file(s)`);
  });

  cells.licences = attempt(() => {
    const inv = inventory(path);
    if (inv.components.length === 0) return { ran: false, why: inv.notRead[0] ?? 'no lockfile Tewip can read' };
    return ran(inv.components.filter((c) => NEEDS_A_LOOK.includes(c.licence.standing)).length, `${inv.components.length} package(s)`);
  });

  cells.access = attempt(() => {
    const { findings, filesRead } = findBarriers(path);
    if (filesRead === 0) return { ran: false, why: 'no markup here that Tewip reads' };
    return ran(findings.filter((f) => f.confidence === 'barrier').length, `${filesRead} markup file(s)`);
  });

  cells.migrations = attempt(() => {
    const files = migrationsUnder(path);
    if (files.length === 0) return { ran: false, why: 'no migrations here' };
    let risky = 0;
    for (const f of files) {
      const m = readMigration(path, f);
      if (!m.unread) risky += m.findings.filter((x) => x.risk === 'destroys-data' || x.risk === 'breaks-old-code').length;
    }
    return ran(risky, `${files.length} migration(s)`);
  });

  cells['hollow tests'] = quick
    ? { ran: false, why: 'skipped: --quick was asked for, and this reads every test in the project' }
    : attempt(() => {
        const files = vouchAll(path, ['.']);
        const tests = files.reduce((n, f) => n + f.judgements.length, 0);
        if (tests === 0) return { ran: false, why: 'no tests found here' };
        const hollow = files.reduce((n, f) => n + f.judgements.filter((j) => ['unfinished-expectation', 'tautology', 'swallows-failure', 'never-runs'].includes(j.verdict)).length, 0);
        return ran(hollow, `${tests} test(s)`);
      });

  return { name: path.split(/[\\/]/).pop() ?? path, path, cells, seconds: (Date.now() - started) / 1000 };
}

export function runPortfolio(cmd: PortfolioCommand): { report: string; rows: RepoRow[] } {
  const root = resolve(cmd.root);
  const paths = checkoutsUnder(root);
  const rows = paths.map((p) => examine(p, cmd.quick));
  const notChecked = [
    'a judgement about which repository matters most: these are counts, and a count is not a priority',
    'anything needing a model, a network call or a running application',
    'whether the tests pass - this reads code, it does not run it',
    cmd.quick ? 'tests that cannot fail: --quick skipped them' : 'how long the slowest check took, which on a large repository is most of the run',
  ];
  const report = renderPortfolio(rows, notChecked);
  console.log(report);
  if (cmd.out) {
    const path = resolve(cmd.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, /\.json$/i.test(path) ? `${JSON.stringify({ root, rows, checks: CHECKS }, null, 2)}\n` : `${report}\n`, 'utf8');
    console.error(`\nWritten to ${cmd.out}`);
  }
  return { report, rows };
}

export type { Check };
