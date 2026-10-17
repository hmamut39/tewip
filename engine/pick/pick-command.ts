// `tewip pick --diff main...HEAD`: the tests that could notice a change, and the command that runs them.
//
// Everything here is a fact read from the project: the diff from git, the test files on disk, the import
// graph followed outwards from each changed file, and the failures Tewip has kept. Nothing is predicted.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { chooseFramework, detectFrameworks } from '../quality/frameworks.ts';
import { changeSummary } from '../quality/grounding.ts';
import { coverageFor, testFiles } from '../review/coverage.ts';
import { importingTests } from '../prove/prove.ts';
import { allTestsReaching } from '../prove/reaches.ts';
import { datasetFiles, readJsonl, readTriageRecords } from '../../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { pick, renderPick, type Candidate, type Picked } from './pick.ts';

export interface PickCommand {
  root: string;
  diff: string;
  /**
   * The changed files, given directly instead of read from git. Used by the safety measurement, which
   * must ask about one file rather than whatever happens to be uncommitted, and by anyone whose change
   * does not come from a git range.
   */
  files?: string[];
  out?: string;
  /** Print only the chosen test files, one per line, for piping into a runner. */
  list?: boolean;
  /** How many recent runs count as "lately" when deciding a test's state is unknown. */
  recentRuns?: number;
  name?: string;
}

const slash = (p: string) => p.split(String.fromCharCode(92)).join('/');

/** Tests that failed in the most recent runs, by the file they live in. */
function recentFailures(root: string, only: string | undefined, howMany: number): { byFile: Map<string, string[]>; noHistory: boolean } {
  const dir = join(root, '.tewip', 'history');
  const byFile = new Map<string, string[]>();
  if (!existsSync(dir)) return { byFile, noHistory: true };
  const runs: RunSummary[] = [];
  const records: TriageRecord[] = [];
  for (const project of only ? [only] : readdirSync(dir)) {
    const where = join(dir, project);
    if (!existsSync(where)) continue;
    runs.push(...readJsonl<RunSummary>(datasetFiles(where).runs));
    records.push(...readTriageRecords(datasetFiles(where).triage));
  }
  if (runs.length === 0) return { byFile, noHistory: true };
  const recent = new Set(
    runs
      .slice()
      .sort((a, b) => (a.finishedAt > b.finishedAt ? -1 : 1))
      .slice(0, howMany)
      .map((r) => r.runId),
  );
  for (const record of records) {
    if (!recent.has(record.runId)) continue;
    const file = slash(String((record as { file?: string }).file ?? ''));
    if (!file) continue;
    byFile.set(file, [...(byFile.get(file) ?? []), record.testId]);
  }
  return { byFile, noHistory: false };
}

/** A test file's path as the history records it, which may be a bare name rather than a full path. */
const sameTest = (testFile: string, recorded: string): boolean => testFile === recorded || testFile.endsWith(`/${recorded}`) || recorded.endsWith(`/${testFile}`);

/**
 * Does this test walk the repository at run time?
 *
 * Such a test - a guard that scans every source file, a check on licence headers, a snapshot of the
 * public API - can be broken by any file in the project, so it must never be skipped. This is not a
 * guess at coverage: it is a statement about what the test reads. Found the hard way, by a safety
 * measurement that caught this project's own control-character guard failing over a change to a module
 * it does not import.
 */
function readsTheRepo(root: string, testFile: string): boolean {
  try {
    const text = readFileSync(resolve(root, testFile), 'utf8');
    const walks = /\breaddirSync\b|\bglob(?:Sync)?\s*\(|\bwalk\s*\(|os\.walk|Files\.walk|filepath\.Walk/.test(text);
    const reads = /\breadFileSync\b|\bopen\s*\(|readFile\b/.test(text);
    return walks && reads;
  } catch {
    return false;
  }
}

/**
 * One command rather than a chain of them. Runners take several files at once, and a line of forty
 * `&&`-joined invocations pays the start-up cost forty times - which is most of the saving the selection
 * was for. The shared prefix is taken from the framework's own command for two files, so nothing is
 * assumed about how it is spelled.
 */
function oneCommand(root: string, picked: Picked, framework: { command(file: string): string; suite: string; cwd: string } | null): string {
  if (!framework) return 'your test command';
  if (picked.mustRun.length === 0) return framework.suite;
  const paths = picked.mustRun.map((m) => resolve(root, m.testFile));
  const first = framework.command(paths[0]);
  if (paths.length === 1) return withCwd(root, framework.cwd, first);
  // Everything before the first quoted argument is the runner. A longest-common-prefix of two commands
  // looked cleverer and cut inside the first file name, producing `node --test "test/ "test/a.ts"`.
  const quote = first.indexOf('"');
  const prefix = quote > 0 ? first.slice(0, quote).trimEnd() : '';
  if (!prefix) return withCwd(root, framework.cwd, picked.mustRun.map((m) => framework.command(resolve(root, m.testFile))).join(' && '));
  const quoted = paths.map((p) => JSON.stringify(relative(framework.cwd, p).split(String.fromCharCode(92)).join('/'))).join(' ');
  return withCwd(root, framework.cwd, `${prefix} ${quoted}`);
}

/** Says where to run it, when that is not the project root. */
const withCwd = (root: string, cwd: string, command: string): string => (resolve(cwd) === resolve(root) ? command : `cd ${JSON.stringify(relative(root, cwd).split(String.fromCharCode(92)).join('/'))} && ${command}`);

/** Test files that mention this file by path or by name, which is weaker than an import but not nothing. */
function mentionsOf(root: string, file: string, tests: string[]): string[] {
  // The name **with its extension**, or the path. Matching the bare stem was useless: for `cli/tewip.ts`
  // the stem is "tewip", which appears in nearly every file of this project, so 28 test files were
  // selected on the grounds that they had mentioned the product's own name.
  const named = file.split('/').pop() ?? '';
  if (named.length < 5) return [];
  const out: string[] = [];
  for (const test of tests) {
    try {
      const text = readFileSync(resolve(root, test), 'utf8');
      if (text.includes(file) || text.includes(named)) out.push(test);
    } catch {
      // Unreadable: it cannot be shown to mention anything.
    }
  }
  return out;
}

/** Does anything at all in the project refer to this file? Used only to tell "unknown" from "unreachable". */
/**
 * Whether anything in the project refers to this file at all.
 *
 * This searched for the file name *with its extension*, which is a JavaScript habit: a JS import
 * often writes `./sorting.js`, and nothing else does. Python writes `from ..utils.sorting import x`,
 * Java writes `import com.x.Sorting`, C# writes `using X.Sorting`. In all of them the extension
 * never appears, so the search found nothing and the file was taken to be referenced nowhere.
 *
 * That is the most dangerous answer this file can produce. "Nothing refers to it" is the one
 * condition that lets selection proceed past a source file no test imports - and on saleor it let
 * `pick` narrow 1,229 test files down to **one**, skipping every sorting test in the suite, for a
 * change to the GraphQL sorting code that all of them run through. The command's own promise is to
 * refuse to narrow when it cannot show the rest are unaffected, and here it could not.
 *
 * The extension comes off. A name like `utils` or `index` will now match half the repository, and
 * that is the right direction to be wrong in: over-matching means "this is referenced", which stops
 * the narrowing. Under-matching skips the tests that would have caught the change.
 */
function mentionedAnywhere(root: string, file: string): boolean {
  const base = file.split('/').pop() ?? '';
  const named = base.replace(/\.[A-Za-z0-9]+$/, '') || base;
  const where = spawnSync('git', ['grep', '-l', '--', named], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const hits = (where.stdout ?? '')
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l && l.split(String.fromCharCode(92)).join('/') !== file);
  return hits.length > 0;
}

export function choose(cmd: PickCommand): { picked: Picked; total: number; command: string; noHistory: boolean } | null {
  const change = cmd.files && cmd.files.length > 0 ? { files: cmd.files } : changeSummary(cmd.root, cmd.diff);
  if (!change) return null;
  const changed = change.files.map(slash);

  const known = testFiles(cmd.root).map(slash);
  const relative = known.map((t) => slash(t).replace(`${slash(cmd.root)}/`, ''));
  const { byFile, noHistory } = recentFailures(cmd.root, cmd.name, cmd.recentRuns ?? 5);

  const candidates: Candidate[] = relative.map((testFile) => {
    const failed: string[] = [];
    for (const [file, ids] of byFile) if (sameTest(testFile, file)) failed.push(...ids);
    return { testFile, recentlyFailed: failed, readsTheRepo: readsTheRepo(cmd.root, testFile) };
  });

  // The import graph, followed outwards from each changed source file.
  const reaching = new Map<string, Array<{ testFile: string; how: string }>>();
  const sources = changed.filter((f) => existsSync(resolve(cmd.root, f)));
  for (const file of sources) {
    // Both kinds, together: a test may import the file itself and others reach it through the package.
    // Taking only the direct importers when there are any is how a selection quietly drops the tests
    // that exercise the code through the application's own front door.
    const direct = importingTests(cmd.root, coverageFor(cmd.root, [file], testFiles(cmd.root)), file);
    const reached = allTestsReaching(cmd.root, file, relative);
    const byFile = new Map<string, { testFile: string; how: string }>();
    for (const r of reached) byFile.set(slash(r.testFile), { testFile: slash(r.testFile), how: `reaches, through ${r.steps} import(s),` });
    for (const testFile of direct) byFile.set(slash(testFile), { testFile: slash(testFile), how: 'imports' });
    reaching.set(file, [...byFile.values()]);
  }

  // A file nothing imports may still be named somewhere - a test that reads it as text, a path in a
  // script, a dynamic import. A mention is not proof that a test exercises it, so a test that mentions
  // it runs; and when nothing in the project mentions it at all, nothing can notice it.
  const unreferenced: string[] = [];
  for (const [file, reaches] of reaching) {
    if (reaches.length > 0) continue;
    const named = mentionsOf(cmd.root, file, relative);
    if (named.length > 0) reaching.set(file, named.map((testFile) => ({ testFile, how: 'names' })));
    else if (!mentionedAnywhere(cmd.root, file)) unreferenced.push(file);
  }

  const framework = chooseFramework(detectFrameworks(cmd.root), undefined, false) ?? detectFrameworks(cmd.root)[0] ?? null;
  const picked = pick({ changed, tests: candidates, reaching, browserTests: Boolean(framework?.browser), noHistory, unreferenced });
  const command = oneCommand(cmd.root, picked, framework);
  return { picked, total: candidates.length, command, noHistory };
}

export function runPick(cmd: PickCommand): void {
  const chosen = choose(cmd);
  if (!chosen) throw new Error(`could not read the change "${cmd.diff}". Is this a git checkout, and does that range exist? (try --diff main...HEAD)`);

  if (cmd.list) {
    // For piping into a runner: the files, and nothing else. A run-everything decision prints nothing,
    // so a script that pipes this cannot mistake "cannot narrow" for "no tests to run".
    if (chosen.picked.runEverything) {
      console.error(`tewip pick: ${chosen.picked.runEverything}. Run the whole suite.`);
      process.exitCode = 2;
      return;
    }
    for (const must of chosen.picked.mustRun) console.log(must.testFile);
    return;
  }

  const report = renderPick(chosen.picked, chosen.total, chosen.command, chosen.noHistory);
  console.log(report);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), report + String.fromCharCode(10), 'utf8');
  }
}
