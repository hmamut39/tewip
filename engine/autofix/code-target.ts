// Phase 12: which application file a failure points at, and which files may never be touched.
//
// Tewip has refused to edit application code since Phase 1. `tewip fix --code` is the one opt-in
// exception, so the first question is not "what should change" but "what is even allowed to
// change". That is decided here, from the stack the runner printed rather than from a guess: the
// topmost frame that is inside the project and is not a test is the code the test was running.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sourceUnderTest } from '../quality/mutation.ts';

/** A file and line named by a stack trace or traceback. */
export interface StackFrame {
  file: string;
  line: number;
}

/**
 * How the runners of different languages print a frame. Every one of these appears in the reports
 * Tewip already reads: Node and browsers, Python, Java and Kotlin, Go, Ruby, PHP, .NET.
 */
const FRAME_PATTERNS: RegExp[] = [
  /at [^(]*\((?:file:\/\/\/)?([A-Za-z]:[^():]+|\/[^():]+|[\w.\-/\\]+\.[A-Za-z]{1,4}):(\d+):\d+\)/g, // JS: at fn (path:12:3)
  /^\s*at (?:file:\/\/\/)?([A-Za-z]:[^():]+|\/[^():]+):(\d+):\d+/gm, // JS: at path:12:3
  /File "([^"]+)", line (\d+)/g, // Python traceback
  /^\s*([A-Za-z]:[^():\s]+|\/[^():\s]+|[\w.\-/\\]+\.go):(\d+)/gm, // Go, and plain path:line lines
  /([\w.\-/\\]+\.(?:rb|php)):(\d+)/g, // Ruby, PHP
  / in ([A-Za-z]:[^():\s]+|\/[^():\s]+):line (\d+)/g, // .NET
  /[❯>]\s+(?:[\w$.]+ )?([\w.\-/\\]+\.[cm]?[jt]sx?):(\d+):\d+/g, // Vitest and Jest: "❯ src/utils.ts:35:11"
];

/** Files that are tests, not the code under test. */
export const isTestFile = (path: string): boolean =>
  /(?:^|[\\/])(?:tests?|spec|specs|__tests__|e2e|cypress|testing)[\\/]/i.test(path) ||
  /(?:\.|_)(?:spec|test)\.[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.py$|_test\.go$|Test(?:s)?\.(?:java|kt|cs)$|(?:^|[\\/])conftest\.py$/i.test(path);

/** Folders whose contents are never the project's own source. */
const NOT_SOURCE = /(?:^|[\\/])(?:node_modules|site-packages|dist|build|out|coverage|target|\.venv|venv|vendor|__pycache__|\.git|\.tewip)[\\/]/i;

/**
 * Files Tewip will not change even when a stack points at them. Changing a lockfile, a CI workflow,
 * a build config or anything holding secrets is not a bug fix, and a test passing afterwards would
 * not mean the bug was fixed.
 */
const NEVER: Array<[RegExp, string]> = [
  [/(?:^|[\\/])\.env/i, 'it holds secrets'],
  [/(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Gemfile\.lock|Cargo\.lock|go\.sum)$/i, 'it is a lockfile'],
  [/(?:^|[\\/])\.github[\\/]/i, 'it is CI configuration'],
  [/(?:^|[\\/])(?:package\.json|tsconfig[^\\/]*\.json|pyproject\.toml|setup\.py|pom\.xml|build\.gradle[^\\/]*|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/i, 'it is project configuration'],
  [/\.(?:config|conf)\.[cm]?[jt]s$|(?:^|[\\/])(?:Dockerfile|docker-compose\.ya?ml)$/i, 'it is build or run configuration'],
  [/(?:^|[\\/])migrations?[\\/]/i, 'it is a database migration, which has already run somewhere'],
  [/\.(?:png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip|lock|snap)$/i, 'it is not source code'],
];

/** Whether Tewip may change this file, and if not, the reason in plain words. */
export function mayChange(path: string): { allowed: boolean; why?: string } {
  if (isTestFile(path)) return { allowed: false, why: 'it is a test: a fix that edits the test is not a fix' };
  if (NOT_SOURCE.test(path)) return { allowed: false, why: 'it is not the project\'s own source' };
  for (const [pattern, why] of NEVER) if (pattern.test(path)) return { allowed: false, why };
  return { allowed: true };
}

/** Every frame in a stack that is a real file inside the project, in the order the runner printed. */
export function stackFrames(stack: string, root: string): StackFrame[] {
  const out: StackFrame[] = [];
  const seen = new Set<string>();
  const base = resolve(root);
  for (const pattern of FRAME_PATTERNS) {
    for (const match of stack.matchAll(pattern)) {
      const raw = match[1].trim();
      const full = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
      const rel = relative(base, full);
      if (rel.startsWith('..') || isAbsolute(rel) || rel.startsWith(sep)) continue;
      if (!existsSync(full) || statSync(full).isDirectory()) continue;
      const key = `${full}:${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: full, line: Number(match[2]) });
    }
  }
  return out;
}

export interface CodeTarget {
  file: string;
  line: number;
  /** Why this file and not another, for the log. */
  why: string;
}

/** The test whose failure is being looked at, when its imports are the only clue to the code. */
export interface TestFacts {
  file: string;
  source: string;
}

/**
 * The application file a failure points at: the first frame that is the project's own source and
 * not a test. A failed assertion - the commonest real bug - has a stack that names only the test,
 * because nothing threw inside the code; there the code the test imports is read instead. When even
 * that is not clear, Tewip says it has no target rather than picking a file to change.
 */
export function codeTarget(stack: string, root: string, test?: TestFacts, hint = ''): { target: CodeTarget | null; why: string; more: CodeTarget[] } {
  const frames = stackFrames(stack, root);
  const refused: string[] = [];
  for (const frame of frames) {
    const rel = relative(resolve(root), frame.file);
    const verdict = mayChange(frame.file);
    if (verdict.allowed) return { target: { file: frame.file, line: frame.line, why: `the stack points at ${rel}:${frame.line}` }, why: '', more: [] };
    refused.push(`${rel} (${verdict.why})`);
  }
  if (test) {
    const imported = sourceUnderTest(test.file, test.source, root);
    // A project with one module per feature exports them all through one file, so the file the test
    // imports is often not the file with the bug. The name of the failing test says which function
    // it is about, so the file that defines that function comes first.
    const byName = definers(imported ? dirname(imported) : dirname(test.file), hint, test.source.slice(0, 2000));
    const ordered = [...byName, ...(imported && !byName.includes(imported) ? [imported] : [])].filter((f) => mayChange(f).allowed);
    if (ordered.length > 0) {
      const say = (f: string) => `nothing threw inside the code, so the file that defines what the test is about was read: ${relative(resolve(root), f)}`;
      return {
        target: { file: ordered[0], line: 1, why: say(ordered[0]) },
        why: '',
        more: ordered.slice(1, 3).map((f) => ({ file: f, line: 1, why: say(f) })),
      };
    }
  }
  if (frames.length === 0) return { target: null, why: 'the failure has no stack trace pointing inside this project, and the test imports no file from it', more: [] };
  return { target: null, why: `every file the failure names is one Tewip may not change: ${refused.slice(0, 3).join('; ')}`, more: [] };
}

/**
 * The source files in a folder that define the functions named in the failure, best match first.
 * This is what tells `parseQuery` in src/query.ts apart from everything else exported by src/.
 */
function definers(dir: string, named: string, mentioned = ''): string[] {
  if (!existsSync(dir)) return [];
  const words = (text: string) => [...new Set((text.match(/[a-z][A-Za-z0-9_$]{3,}/g) ?? []).filter((n) => /[A-Z]/.test(n) || n.length > 5))].slice(0, 40);
  // The failing test's own name says which function it is about, and counts far more than a name
  // that merely appears somewhere in the test file: a file of utilities mentions dozens of them.
  const strong = words(named);
  const weak = words(mentioned).filter((n) => !strong.includes(n));
  if (strong.length === 0 && weak.length === 0) return [];
  const defines = (source: string, name: string) => new RegExp(String.raw`(?:export\s+(?:async\s+)?(?:function|const|class)\s+|^def\s+)${name}\b`, 'm').test(source);
  const scored: Array<{ file: string; score: number }> = [];
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (!/\.[cm]?[jt]sx?$|\.py$/.test(entry) || isTestFile(file) || !statSync(file).isFile()) continue;
    const source = readFileSync(file, 'utf8');
    const score = strong.filter((n) => defines(source, n)).length * 5 + weak.filter((n) => defines(source, n)).length;
    if (score > 0) scored.push({ file, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.file);
}
