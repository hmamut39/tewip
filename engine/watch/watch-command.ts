// `tewip watch`: the diagnosis on your own machine, the moment a test fails - no CI, no waiting.
//
// Two ways to use it, and they are the same loop:
//   tewip watch --cmd "npm test"   runs your tests, explains what failed, and does it again when a
//                                  file changes, so you keep the terminal open while you work;
//   tewip watch                    watches for new test reports written by whatever you run
//                                  yourself, and explains each one as it appears.
//
// It only ever reads reports and runs the command you gave it. It writes nothing but its own
// history folder.
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectFrameworks } from '../quality/frameworks.ts';

/** Where test runners in this project put their reports, in the order they are usually found. */
export const REPORT_PLACES = [
  'blob-report',
  'test-results',
  'report.xml',
  'junit.xml',
  'results.xml',
  'test-results.xml',
  join('reports', 'junit.xml'),
  join('target', 'surefire-reports'),
  join('build', 'test-results', 'test'),
  join('TestResults'),
];

/** The newest report in this project, if any: what a run just wrote. */
export function newestReport(root: string, places: string[] = REPORT_PLACES): { path: string; at: number } | null {
  let best: { path: string; at: number } | null = null;
  const consider = (path: string, at: number) => {
    if (at > 0 && (!best || at > best.at)) best = { path, at };
  };
  for (const place of places) {
    const path = join(root, place);
    if (!existsSync(path)) continue;
    const info = statSync(path);
    // A folder of reports counts as changed when anything inside it changed.
    consider(path, info.isDirectory() ? newestInside(path) : info.mtimeMs);
  }
  // Report files are named whatever the runner was told to call them, so a file in the project
  // folder counts too - but only if it really is a test report, which its first bytes say.
  for (const entry of readdirSync(root)) {
    if (!/\.(?:xml|trx)$/i.test(entry)) continue;
    const path = join(root, entry);
    if (!statSync(path).isFile() || !looksLikeReport(path)) continue;
    consider(path, statSync(path).mtimeMs);
  }
  return best;
}

/** A test report, not a build file: pom.xml and web.config are XML too. */
export function looksLikeReport(path: string): boolean {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 2000);
    return /<testsuites?\b|<TestRun\b|<test-run\b|<assemblies\b/i.test(head);
  } catch {
    return false;
  }
}

function newestInside(dir: string, depth = 2): number {
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    const at = info.isDirectory() ? (depth > 0 ? newestInside(path, depth - 1) : 0) : info.mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
}

export interface WatchCommand {
  root: string;
  /** The test command to run, e.g. "npm test". Without it, Tewip only watches for new reports. */
  cmd?: string;
  /** Watch this report path instead of looking for the usual ones. */
  report?: string;
  /** Watch these folders for changes, to run the tests again. */
  paths: string[];
  /** Explain what is already there once, then stop (used by the tests). */
  once?: boolean;
  explain?: (report: string, root: string) => Promise<void>;
  run?: (cmd: string, root: string) => { code: number; output: string };
}

const runCommand = (cmd: string, root: string) => {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'], timeout: 30 * 60_000 });
  return { code: r.status ?? 1, output: '' };
};

/** Explains one report with the same code `tewip explain` uses. */
async function explainReport(report: string, root: string): Promise<void> {
  process.env.TEWIP_LLM_CACHE ??= join(root, '.tewip', 'llm-cache.jsonl');
  const argv = process.argv;
  process.argv = [argv[0], 'tewip-explain', report, '--name', 'watch'];
  try {
    // A fresh import each time: the script runs its work on import, as the CLI expects.
    await import(`../../scripts/explain.ts?watch=${Date.now()}`);
  } finally {
    process.argv = argv;
  }
}

const WATCHED = /\.(?:[jt]sx?|mjs|cjs|py|java|kt|cs|go|rb|php|vue|svelte)$/;
const SKIP_DIR = /(?:^|[\\/])(?:node_modules|\.git|\.tewip|dist|build|target|coverage|venv|\.venv|__pycache__|blob-report|test-results)(?:[\\/]|$)/;

/**
 * Watches the project and explains failures as they appear. Returns when `once` is set; otherwise
 * it runs until the person stops it, which is what a terminal beside your editor is for.
 */
/**
 * What to change so the next run can be explained - named for the runner this project actually uses.
 *
 * The advice was a fixed list of three examples: pytest, jest, dotnet. Field-tested on a project
 * using **`node --test`**, Node's own built-in runner, the suite failed with a perfectly clear
 * assertion - `26 !== 25`, the test named, the line numbered - and the answer was a list that did
 * not mention the runner failing in front of it. Telling somebody to configure jest when they are
 * not using jest is the kind of advice that gets a tool closed.
 *
 * The frameworks this project has are already detectable, so the first line is the one command that
 * will work here, and the examples stay underneath for anyone whose runner was not found.
 */
export function howToWriteAReport(root: string): string {
  const JUNIT: Record<string, string> = {
    node: 'node --test --test-reporter=junit --test-reporter-destination=report.xml',
    jest: 'npx jest --reporters=default --reporters=jest-junit',
    vitest: 'npx vitest run --reporter=junit --outputFile=report.xml',
    mocha: 'npx mocha --reporter mocha-junit-reporter',
    pytest: 'pytest --junitxml=report.xml',
    go: 'gotestsum --junitfile report.xml',
    dotnet: 'dotnet test --logger trx',
    maven: 'mvn test   (Surefire already writes XML to target/surefire-reports)',
    gradle: './gradlew test   (already writes XML to build/test-results)',
    playwright: 'npx playwright test --reporter=blob',
  };
  const here = detectFrameworks(root)
    .map((f) => JUNIT[f.id])
    .filter((line, i, all): line is string => Boolean(line) && all.indexOf(line) === i);
  const head = 'The tests failed but wrote no report Tewip can read.';
  if (here.length === 0) {
    return `${head} Make the runner write JUnit XML (for example: pytest --junitxml=report.xml, jest --reporters=jest-junit, dotnet test --logger trx).`;
  }
  return [`${head} For the runner${here.length === 1 ? '' : 's'} this project has, that is:`, ...here.map((line) => `  ${line}`)].join(String.fromCharCode(10));
}

export async function runWatch(cmd: WatchCommand): Promise<void> {
  const root = resolve(cmd.root);
  const explain = cmd.explain ?? explainReport;
  const run = cmd.run ?? runCommand;
  let busy = false;
  let seen = 0;

  const look = async (why: string) => {
    if (busy) return;
    busy = true;
    try {
      if (cmd.cmd) {
        console.log(`\n${why}: running ${cmd.cmd}`);
        const result = run(cmd.cmd, root);
        if (result.code === 0) {
          console.log('Everything passed.');
          return;
        }
      }
      const found = cmd.report ? { path: resolve(root, cmd.report), at: Date.now() } : newestReport(root);
      if (!found || !existsSync(found.path)) {
        console.log(cmd.cmd ? howToWriteAReport(root) : 'No test report here yet. Run your tests, or use --cmd "npm test" to let Tewip run them.');
        return;
      }
      if (!cmd.cmd && found.at === seen) return;
      seen = found.at;
      await explain(found.path, root);
    } finally {
      busy = false;
    }
  };

  await look(cmd.cmd ? 'Starting' : 'Looking at the newest report');
  if (cmd.once) return;

  const places = cmd.paths.length > 0 ? cmd.paths : ['.'];
  console.log(`\nWatching ${places.join(', ')} for changes. Press Ctrl+C to stop.`);
  for (const place of places) {
    const dir = resolve(root, place);
    if (!existsSync(dir)) continue;
    watch(dir, { recursive: true }, (_event, file) => {
      const name = String(file ?? '');
      if (SKIP_DIR.test(name)) return;
      // Without a command to run, a new report is the signal; with one, a source change is.
      if (cmd.cmd ? WATCHED.test(name) : /\.(?:xml|trx|zip|json)$/.test(name)) void look(`${name} changed`);
    });
  }
  await new Promise(() => {});
}
