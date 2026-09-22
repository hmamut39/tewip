// Phase 7, the stronger check: would this test notice a change in the code it covers?
//
// `tewip write` already breaks the test's own main check and requires it to fail. That proves the
// assertion matters, but it mutates the TEST. Real mutation testing changes the CODE UNDER TEST and
// asks whether the test catches it, which is the question a reviewer actually has.
//
// It is opt-in (`--mutate-source`) and deliberately narrow, because the honest reading of the
// research is that a full mutation run is far too slow to sit inside a write loop: Google surfaces
// at most 7 mutants per file and still sees a median of 2 survivors per change. So: unit frameworks
// only (never browser tests, where one run costs a rebuild), only when the project already has the
// tool installed, only one source file, and only when a narrowed run is fast.
//
// What it reports is a count of noticed changes, never a "mutation score" percentage: the published
// correlation between that percentage and real fault detection is weak once suite size is
// controlled (Papadakis et al., ICSE 2018), so a percentage would be a number that sounds like
// quality without being it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { Framework } from './frameworks.ts';

/** How long one narrowed mutation run may take before it is not worth it inside a write loop. */
export const MUTATION_BUDGET_MS = 120_000;
/** Above this, a single test run is too slow for the dozens of runs a mutation tool needs. */
export const TOO_SLOW_PER_RUN_MS = 5_000;

export interface MutationTool {
  id: 'stryker' | 'pit' | 'cosmic-ray' | 'stryker-net' | 'go-mutesting';
  /** The command that mutates one source file and runs one test file against it. */
  command(sourceFile: string, testFile: string): string;
  /** How to install it, for the report when it is missing. */
  install: string;
}

/** The tool a project already has for its framework, or why there is none. */
export function mutationTool(framework: Framework): MutationTool | { missing: string; install: string } | null {
  const has = (path: string) => existsSync(join(framework.cwd, path));
  const rel = (f: string) => relative(framework.cwd, f).replaceAll('\\', '/');
  switch (framework.id) {
    case 'jest':
    case 'vitest': {
      const install = 'npm i -D @stryker-mutator/core @stryker-mutator/' + (framework.id === 'jest' ? 'jest-runner' : 'vitest-runner');
      if (!has('node_modules/@stryker-mutator/core')) return { missing: 'StrykerJS is not installed in this project', install };
      return {
        id: 'stryker',
        install,
        command: (source, test) => `npx stryker run --mutate ${JSON.stringify(rel(source))} --testFiles ${JSON.stringify(rel(test))} --testRunner ${framework.id} --reporters json --concurrency 50%`,
      };
    }
    case 'maven': {
      const install = 'add the org.pitest:pitest-maven plugin to pom.xml';
      if (!/pitest/.test(readFileSync(join(framework.cwd, 'pom.xml'), 'utf8'))) return { missing: 'PIT is not configured in pom.xml', install };
      const className = (f: string) => rel(f).replace(/^src\/(main|test)\/java\//, '').replace(/\.java$/, '').replaceAll('/', '.');
      return {
        id: 'pit',
        install,
        command: (source, test) =>
          `mvn -q test-compile org.pitest:pitest-maven:mutationCoverage -DtargetClasses=${className(source)} -DtargetTests=${className(test)} -DoutputFormats=XML -DtimestampedReports=false`,
      };
    }
    case 'pytest': {
      const install = 'pip install cosmic-ray';
      return { missing: 'cosmic-ray is not set up for this project', install };
    }
    default:
      // Browser frameworks and the rest: a mutation run would cost a rebuild per mutant.
      return null;
  }
}

/**
 * The single source file a test covers, from its own imports: the nearest one it pulls in by a
 * relative path. Guessing more widely would mutate a file the test never touches, and report a
 * survivor that means nothing.
 */
export function sourceUnderTest(testFile: string, testCode: string, root: string): string | null {
  const imports = [...testCode.matchAll(/(?:from|import|require\()\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  const here = dirname(testFile);
  for (const spec of imports) {
    const base = resolve(here, spec);
    const candidates = extname(base) ? [base] : ['.ts', '.tsx', '.js', '.jsx', '.mjs'].flatMap((ext) => [base + ext, join(base, 'index' + ext)]);
    const found = candidates.find((c) => existsSync(c) && c.startsWith(resolve(root)) && !/\.(spec|test)\./.test(c));
    if (found) return throughBarrel(found, testCode) ?? found;
  }
  return null;
}

/**
 * A project's index file usually only re-exports. Mutating it would change nothing worth noticing,
 * so when the import lands on one, this follows the names the test actually imported to the file
 * that defines them.
 */function throughBarrel(file: string, testCode: string): string | null {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  if (!lines.every((l) => /^\s*(?:export|import)\b/.test(l))) return null;
  const names = [...testCode.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.[^'"]+['"]/g)]
    .flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()))
    .map((n) => n.replace(/[^\w$]/g, ''))
    .filter(Boolean);
  if (names.length === 0) return null;
  const dir = dirname(file);
  const defines = new RegExp(String.raw`export\s+(?:async\s+)?(?:function|const|class|let|var)\s+(?:${names.join('|')})\b`);
  for (const entry of readdirSync(dir)) {
    const candidate = join(dir, entry);
    if (candidate === file || !/\.[cm]?[jt]sx?$/.test(entry) || /\.(spec|test)\./.test(entry)) continue;
    if (statSync(candidate).isFile() && defines.test(readFileSync(candidate, 'utf8'))) return candidate;
  }
  return null;
}
export interface MutationResult {
  tool: MutationTool['id'];
  /** Changes to the code that this test noticed: it failed, as it should. */
  noticed: number;
  /** Changes this test ran through and did not notice: it kept passing while the code was wrong. */
  missed: Array<{ line: number; change: string }>;
  /** Changes in code this test never runs. Not a fault of the test: one test covers one behaviour. */
  notExercised: number;
  /** Changes the tool could not judge (did not compile, timed out). */
  inconclusive: number;
}

/** StrykerJS writes mutation-testing-elements JSON; PIT writes mutations.xml. */
export function readMutationReport(tool: MutationTool['id'], cwd: string): MutationResult | null {
  if (tool === 'stryker') {
    const path = join(cwd, 'reports', 'mutation', 'mutation.json');
    if (!existsSync(path)) return null;
    const report = JSON.parse(readFileSync(path, 'utf8')) as {
      files?: Record<string, { mutants: Array<{ status: string; replacement?: string; mutatorName?: string; location?: { start?: { line?: number } } }> }>;
    };
    const result: MutationResult = { tool, noticed: 0, missed: [], notExercised: 0, inconclusive: 0 };
    for (const file of Object.values(report.files ?? {})) {
      for (const m of file.mutants) {
        if (m.status === 'Killed') result.noticed++;
        else if (m.status === 'Survived') result.missed.push({ line: m.location?.start?.line ?? 0, change: m.replacement ?? m.mutatorName ?? 'a change' });
        else if (m.status === 'NoCoverage') result.notExercised++;
        else if (m.status !== 'Ignored' && m.status !== 'Pending') result.inconclusive++;
      }
    }
    return result;
  }
  if (tool === 'pit') {
    const path = join(cwd, 'target', 'pit-reports', 'mutations.xml');
    if (!existsSync(path)) return null;
    const xml = readFileSync(path, 'utf8');
    const result: MutationResult = { tool, noticed: 0, missed: [], notExercised: 0, inconclusive: 0 };
    for (const m of xml.matchAll(/<mutation detected='(true|false)' status='(\w+)'[\s\S]*?<lineNumber>(\d+)<\/lineNumber>[\s\S]*?<mutator>([^<]+)<\/mutator>/g)) {
      if (m[1] === 'true') result.noticed++;
      else if (m[2] === 'SURVIVED') result.missed.push({ line: Number(m[3]), change: m[4].split('.').at(-1) ?? 'a change' });
      else if (m[2] === 'NO_COVERAGE') result.notExercised++;
      else result.inconclusive++;
    }
    return result;
  }
  return null;
}

/**
 * One line for the report. Only the changes this test actually ran through count for or against it:
 * a change in code it never touches says nothing about the test, and counting those would turn a
 * narrow, correct test into an alarming number.
 */
export function describeMutation(result: MutationResult, sourceFile: string): string {
  const where = sourceFile.replaceAll('\\', '/').split('/').slice(-2).join('/');
  const exercised = result.noticed + result.missed.length;
  const rest = result.notExercised > 0 ? `; ${result.notExercised} other change(s) there are in code this test does not run` : '';
  if (exercised === 0) return `changed ${where} in ${result.notExercised} place(s), none of them in code this test runs`;
  if (result.missed.length === 0) return `noticed all ${exercised} change(s) it exercised in ${where}${rest}`;
  const worst = result.missed.slice(0, 3).map((m) => `line ${m.line} (${m.change.replace(/\s+/g, ' ').slice(0, 40)})`).join(', ');
  return `noticed ${result.noticed} of ${exercised} change(s) it exercised in ${where}, missing ${worst}${rest}`;
}
