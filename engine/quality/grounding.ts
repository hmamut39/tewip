// Facts Tewip reads before it plans or writes tests, so the model works from the project as it is
// instead of inventing it: the tests that already exist, what a change touched, and what the
// running app's pages actually contain.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.tewip', '.venv', 'venv', '__pycache__', 'target', 'vendor', 'coverage', 'test-results', 'playwright-report', 'blob-report']);
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|java|kt|cs|go|rb|php|rs)$/;
const TEST_FILE = /(\.(spec|test)\.[cm]?[jt]sx?$)|(^test_.*\.py$)|(_test\.(py|go)$)|(Tests?\.(java|kt|cs)$)|(_spec\.rb$)|(Test\.php$)/;

/** Test names found in one file, for the languages Tewip reads reports from. */
function testNames(source: string): string[] {
  const patterns = [
    /\b(?:test|it)(?:\.only|\.skip)?\(\s*(['"`])((?:(?!\1).)+)\1/g, // Playwright, Jest, Vitest, Mocha, node:test
    /^\s*def (test_\w+)/gm, // pytest, unittest
    /^func (Test\w+)\(/gm, // Go
    /@Test[\s\S]{0,120}?\bvoid (\w+)\s*\(/g, // JUnit, TestNG
    /\[(?:Fact|Test|TestMethod)\][\s\S]{0,120}?\bvoid (\w+)\s*\(/g, // xUnit, NUnit, MSTest
    /^\s*it\s+['"]([^'"]+)['"]/gm, // RSpec
    /function (test\w+)\s*\(/g, // PHPUnit
  ];
  const out: string[] = [];
  for (const p of patterns) for (const m of source.matchAll(p)) out.push((m[2] ?? m[1]).trim());
  return out;
}

export interface ExistingTests {
  files: number;
  /** "file: test name", capped, so the model knows what is already covered. */
  tests: string[];
}

/** The tests already in the project, found by file name and read for their names. */
export function existingTests(root: string, cap = 300): ExistingTests {
  const tests: string[] = [];
  let files = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(join(dir, entry.name), depth + 1);
      } else if (TEST_FILE.test(entry.name)) {
        const path = join(dir, entry.name);
        if (statSync(path).size > 1_000_000) continue;
        files++;
        const rel = relative(root, path).replaceAll('\\', '/');
        for (const name of testNames(readFileSync(path, 'utf8'))) if (tests.length < cap) tests.push(`${rel}: ${name}`);
      }
    }
  };
  walk(root, 0);
  return { files, tests };
}

export interface TestSource {
  file: string;
  content: string;
}

const STOPWORDS = new Set(['with', 'that', 'this', 'from', 'into', 'when', 'then', 'them', 'they', 'their', 'each', 'what', 'which', 'reads', 'back', 'sees', 'must', 'should', 'have', 'does', 'test', 'tests', 'user', 'page', 'able', 'also', 'only', 'other', 'more', 'than', 'will']);

/**
 * The full text of the tests most related to a feature. Test names alone hide what table-driven
 * tests (test.each, parametrize, @ParameterizedTest, a list of cases in a loop) already check, so
 * the planner also reads the files that mention the feature's words most, rare words counting
 * most. With kind 'code', the same for the source files the feature lives in. Tests Tewip wrote
 * itself are left out: they are not the project's own conventions.
 */
export function relatedTestSources(root: string, feature: string, maxFiles = 4, maxChars = 8_000, kind: 'tests' | 'code' = 'tests'): TestSource[] {
  const wanted = (name: string) => (kind === 'tests' ? TEST_FILE.test(name) : CODE_FILE.test(name) && !TEST_FILE.test(name) && !/\.d\.ts$|\.min\.js$|\.config\./.test(name));
  const words = [...new Set(feature.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [])].filter((t) => !STOPWORDS.has(t.toLowerCase()));
  // Names written like code (with_query, withQuery) almost surely point at the right file.
  const codeLike = words.map((t) => /[a-z][A-Z]|_/.test(t));
  const terms = words.map((t) => t.toLowerCase());
  if (terms.length === 0) return [];
  const files: Array<{ file: string; content: string; hits: number[] }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path, depth + 1);
      } else if (wanted(entry.name) && !/tewip/i.test(entry.name) && statSync(path).size <= 1_000_000) {
        const content = readFileSync(path, 'utf8');
        const lower = content.toLowerCase();
        files.push({ file: relative(root, path).replaceAll('\\', '/'), content, hits: terms.map((t) => Math.min(20, lower.split(t).length - 1)) });
      }
    }
  };
  walk(root, 0);
  // A word found in few files says more about which file is meant than one found everywhere
  // (tf-idf): "naturalsize" picks the file-size tests, "number" or "format" pick nothing in particular.
  const weight = terms.map((_, i) => Math.log(1 + files.length / Math.max(1, files.filter((f) => f.hits[i] > 0).length)) * (codeLike[i] ? 3 : 1));
  // Pick greedily by what each file adds: once a chosen file covers a word, that word counts a
  // quarter as much, so a feature naming two functions gets the tests of both.
  const left = [...weight];
  const chosen: typeof files = [];
  const gain = (f: (typeof files)[number]) => f.hits.reduce((sum, h, i) => sum + Math.log(1 + h) * left[i], 0);
  while (chosen.length < maxFiles) {
    const best = files.filter((f) => !chosen.includes(f)).sort((x, y) => gain(y) - gain(x))[0];
    if (!best || gain(best) <= 0) break;
    chosen.push(best);
    best.hits.forEach((h, i) => (left[i] = h > 0 ? left[i] / 4 : left[i]));
  }
  return chosen.map(({ file, content }) => ({ file, content: content.length > maxChars ? `${content.slice(0, maxChars)}\n... (cut)` : content }));
}

export interface ChangeSummary {
  range: string;
  files: string[];
  /** The diff itself, cut to a size a model can read. */
  patch: string;
}

/** What a git range changed (e.g. "main...HEAD"); null outside a git checkout. */
export function changeSummary(root: string, range: string, maxPatch = 12_000): ChangeSummary | null {
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = git(['diff', '--name-only', range]).split('\n').filter(Boolean);
    const patch = git(['diff', '--unified=2', range]);
    return { range, files, patch: patch.length > maxPatch ? `${patch.slice(0, maxPatch)}\n... (diff cut at ${maxPatch} characters)` : patch };
  } catch {
    return null;
  }
}

export interface PageFacts {
  url: string;
  title: string;
  /** Playwright's accessibility snapshot: roles and names as a user (and a locator) sees them. */
  aria: string;
}

/**
 * Playwright as the project installed it, found from the project's own folders (the root, or a
 * browser-test folder such as e2e/ one or two levels down), then Tewip's own copy. An installed
 * Tewip cannot see the project's node_modules through a plain import, so it resolves them here.
 */
async function loadChromium(root: string): Promise<{ launch: () => Promise<any> } | null> {
  const dirs = [root];
  for (const a of readdirSync(root, { withFileTypes: true })) {
    if (!a.isDirectory() || SKIP_DIRS.has(a.name) || a.name.startsWith('.')) continue;
    dirs.push(join(root, a.name));
    for (const b of readdirSync(join(root, a.name), { withFileTypes: true })) {
      if (b.isDirectory() && !SKIP_DIRS.has(b.name) && !b.name.startsWith('.')) dirs.push(join(root, a.name, b.name));
    }
  }
  for (const dir of dirs) {
    for (const name of ['@playwright/test', 'playwright']) {
      if (!existsSync(join(dir, 'node_modules', ...name.split('/')))) continue;
      try {
        const entry = createRequire(join(dir, 'package.json')).resolve(name);
        const m = (await import(pathToFileURL(entry).href)) as any;
        if (m.chromium ?? m.default?.chromium) return m.chromium ?? m.default.chromium;
      } catch {
        // an unusable install here; try the next folder
      }
    }
  }
  for (const name of ['@playwright/test', 'playwright']) {
    try {
      return ((await import(name as string)) as any).chromium;
    } catch {
      // not bundled with Tewip either
    }
  }
  return null;
}

/**
 * What a page of the running app contains, read with Playwright. Returns no pages and a reason when
 * Playwright or its browser is not available, rather than failing the whole command.
 */
export async function readPages(urls: string[], root = process.cwd(), maxAria = 8_000): Promise<{ pages: PageFacts[]; note: string | null }> {
  if (urls.length === 0) return { pages: [], note: null };
  const chromium = await loadChromium(root);
  if (!chromium) return { pages: [], note: 'Playwright is not installed in this project, so the pages were not read (npm install -D @playwright/test && npx playwright install chromium).' };
  let browser: any;
  try {
    browser = await chromium.launch();
  } catch (error) {
    return { pages: [], note: `Playwright could not start a browser, so the pages were not read (npx playwright install chromium): ${String(error instanceof Error ? error.message : error).split('\n')[0]}` };
  }
  try {
    const page = await browser.newPage();
    const pages: PageFacts[] = [];
    for (const url of urls) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      const aria: string = await page.locator('body').ariaSnapshot();
      pages.push({ url, title: await page.title(), aria: aria.length > maxAria ? `${aria.slice(0, maxAria)}\n... (cut)` : aria });
    }
    return { pages, note: null };
  } catch (error) {
    return { pages: [], note: `The pages could not be read: ${String(error instanceof Error ? error.message : error).split('\n')[0]}` };
  } finally {
    await browser.close();
  }
}

/** The source files (not tests) most related to a feature: what it does and what its comments promise. */
export const relatedCodeSources = (root: string, feature: string): TestSource[] => relatedTestSources(root, feature, 2, 6_000, 'code');
