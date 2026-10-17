// What the tests actually executed, read from a report the project already produces.
//
// Everything else in Tewip follows imports to decide what a test reaches, and Phases 46 and 52 found
// the same wall twice: a test that posts a GraphQL query, hits an HTTP route or renders a Rails
// controller never imports the code it exercises. `done` had to answer "cannot say" and `pick` had to
// refuse to narrow - honest both times, and useless to a Python or Rails team.
//
// A coverage report settles it, and CI already makes one. This reads the four formats that between
// them cover most of what runs anywhere:
//
//   lcov.info      JavaScript, TypeScript, C, C++, Rust, Go
//   coverage.xml   Cobertura: pytest-cov, Jacoco's cobertura output, coverlet for .NET, simplecov
//   jacoco.xml     Java and Kotlin
//   clover.xml     PHPUnit
//
// What a coverage report can and cannot say is worth being exact about. It records which lines ran
// during the whole suite - not which test ran them. So it answers "is this code executed by the
// tests at all", which is what `done` asks, and it does **not** answer "which tests would notice a
// change here", which is what `pick` asks. Only a per-test context report answers that, and this
// reads one when the project produced it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface Coverage {
  /** Where the report was found, so a report can say which file it believed. */
  from: string;
  /** Lines executed at least once, by source file, relative to the project root and slashed. */
  executed: Map<string, Set<number>>;
  /** Source files the report mentions at all, executed or not. */
  mentioned: Set<string>;
}

/** The names CI tools write, in the order worth trying. */
const REPORTS = [
  'coverage/lcov.info',
  'lcov.info',
  'coverage.xml',
  'coverage/coverage.xml',
  'target/site/jacoco/jacoco.xml',
  'build/reports/jacoco/test/jacocoTestReport.xml',
  'jacoco.xml',
  'clover.xml',
  'coverage/clover.xml',
  'build/logs/clover.xml',
];

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');

/** The coverage report this project has produced, or null when it has not produced one. */
export function findCoverage(root: string): Coverage | null {
  for (const name of REPORTS) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).size > 64 * 1024 * 1024) continue;
      const text = readFileSync(path, 'utf8');
      const parsed = name.endsWith('.info') ? readLcov(text, root) : readXml(text, root);
      if (parsed.mentioned.size > 0) return { from: slash(relative(root, path)), ...parsed };
    } catch {
      continue;
    }
  }
  return null;
}

/** LCOV: `SF:` opens a file, `DA:<line>,<hits>` records one line. */
export function readLcov(text: string, root = ''): Omit<Coverage, 'from'> {
  const executed = new Map<string, Set<number>>();
  const mentioned = new Set<string>();
  let file = '';
  for (const raw of text.split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      file = normalise(line.slice(3), root);
      mentioned.add(file);
      if (!executed.has(file)) executed.set(file, new Set());
      continue;
    }
    if (!file || !line.startsWith('DA:')) continue;
    const [at, hits] = line.slice(3).split(',');
    if (Number(hits) > 0) executed.get(file)?.add(Number(at));
  }
  return { executed, mentioned };
}

/**
 * Cobertura, JaCoCo and Clover in one reader, because all three say the same thing in the same
 * shape: a filename attribute, then elements carrying a line number and a hit count.
 *
 * Read with regular expressions rather than an XML parser on purpose - these files reach hundreds of
 * megabytes on a large suite, and nothing here needs the tree.
 */
export function readXml(text: string, root = ''): Omit<Coverage, 'from'> {
  const executed = new Map<string, Set<number>>();
  const mentioned = new Set<string>();
  // Cobertura nests <class filename="x">; JaCoCo has <sourcefile name="x"> inside <package name="y">;
  // Clover has <file path="x">. Each opens a file and owns the line elements until the next one.
  const opens = /<(?:class[^>]*filename|sourcefile[^>]*name|file[^>]*(?:path|name))\s*=\s*"([^"]+)"/g;
  const starts: Array<{ at: number; file: string }> = [];
  for (const m of text.matchAll(opens)) starts.push({ at: m.index ?? 0, file: m[1] });
  // JaCoCo names the package separately and the sourcefile without its directory, so the two are
  // joined back together. Without this every file reads as a bare name that matches nothing.
  const packages = [...text.matchAll(/<package[^>]*name\s*=\s*"([^"]+)"/g)].map((m) => ({ at: m.index ?? 0, name: m[1] }));
  const packageFor = (at: number): string => {
    let found = '';
    for (const p of packages) {
      if (p.at > at) break;
      found = p.name;
    }
    return found;
  };

  for (const [i, start] of starts.entries()) {
    const until = starts[i + 1]?.at ?? text.length;
    const within = text.slice(start.at, until);
    const inPackage = /<sourcefile/.test(text.slice(start.at, start.at + 12)) ? packageFor(start.at) : '';
    const file = normalise(inPackage ? `${inPackage}/${start.file}` : start.file, root);
    mentioned.add(file);
    if (!executed.has(file)) executed.set(file, new Set());
    // Cobertura: <line number="3" hits="1"/>  JaCoCo: <line nr="3" ci="2"/>  Clover: <line num="3" count="1"/>
    for (const line of within.matchAll(/<line[^>]*\b(?:number|nr|num)\s*=\s*"(\d+)"[^>]*\b(?:hits|ci|count)\s*=\s*"(\d+)"/g)) {
      if (Number(line[2]) > 0) executed.get(file)?.add(Number(line[1]));
    }
  }
  return { executed, mentioned };
}

/**
 * The report's path for a source file, as a path relative to the project and slashed.
 *
 * Reports disagree about this more than about anything else: lcov writes an absolute path, Cobertura
 * a path relative to a `<source>` root it declares separately, JaCoCo a package and a bare file name.
 * Everything here is reduced to the same shape so that a changed file from a git diff can be looked
 * up without the caller knowing which tool wrote the report.
 */
function normalise(file: string, root: string): string {
  const path = slash(file).replace(/^\.\//, '');
  if (!root) return path;
  const full = slash(resolve(root, path));
  const base = slash(resolve(root));
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : path;
}

/** True when the report shows this file running at least one line. */
export function wasExecuted(coverage: Coverage, file: string): boolean {
  return (coverage.executed.get(slash(file))?.size ?? 0) > 0;
}

/**
 * Whether the report covers this project at all.
 *
 * A stale report from a different checkout, or one whose paths do not line up, would otherwise be
 * read as "nothing in this change is tested" - which is the confident wrong answer this whole
 * exercise exists to avoid. If none of the files it names exist on disk, it is not about this tree.
 */
export function describesThisProject(coverage: Coverage, root: string): boolean {
  let found = 0;
  let checked = 0;
  for (const file of coverage.mentioned) {
    if (checked >= 20) break;
    checked += 1;
    if (existsSync(join(root, file))) found += 1;
  }
  return checked > 0 && found / checked >= 0.5;
}

/** Any coverage report under the project, for a report that wants to say where it looked. */
export function reportsUnder(root: string, limit = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(full, depth + 1);
      else if (/^(lcov\.info|coverage\.xml|jacoco.*\.xml|clover\.xml)$/i.test(entry)) out.push(slash(relative(root, full)));
    }
  };
  walk(root, 0);
  return out;
}
