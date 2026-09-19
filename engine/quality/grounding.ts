// Facts Tewip reads before it plans or writes tests, so the model works from the project as it is
// instead of inventing it: the tests that already exist, what a change touched, and what the
// running app's pages actually contain.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.tewip', '.venv', 'venv', '__pycache__', 'target', 'vendor', 'coverage', 'test-results', 'playwright-report', 'blob-report']);
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
 * What a page of the running app contains, read with Playwright. Returns null with a reason when
 * Playwright or its browser is not installed, rather than failing the whole command.
 */
export async function readPages(urls: string[], maxAria = 8_000): Promise<{ pages: PageFacts[]; note: string | null }> {
  if (urls.length === 0) return { pages: [], note: null };
  let chromium: { launch: () => Promise<any> };
  try {
    ({ chromium } = (await import('@playwright/test')) as any);
  } catch {
    try {
      ({ chromium } = (await import('playwright' as string)) as any);
    } catch {
      return { pages: [], note: 'Playwright is not installed, so the pages were not read (npm install -D @playwright/test && npx playwright install chromium).' };
    }
  }
  const browser = await chromium.launch();
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
