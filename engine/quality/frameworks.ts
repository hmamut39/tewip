// Which test frameworks a project uses, where their tests live, and how to run one test file.
// Tewip writes tests in the project's own framework and style, so it reads this from the project
// (config files, dependencies, existing tests) instead of assuming Playwright. It looks in the root
// and two levels below, because many repositories keep browser tests in their own folder.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export type FrameworkId = 'playwright' | 'cypress' | 'webdriverio' | 'angular' | 'jest' | 'vitest' | 'pytest' | 'maven' | 'gradle' | 'dotnet' | 'go';

export interface Framework {
  id: FrameworkId;
  /** For the model and the report, e.g. "pytest with Selenium (Python)". */
  label: string;
  /** Browser tests (drive a page) rather than unit or API tests. */
  browser: boolean;
  /** Where the runner is started. */
  cwd: string;
  /** Where a new test goes: beside the example, so imports and config apply as they do to it. */
  testDir: string;
  /** An existing test to copy the style of (imports, helpers, how pages are opened). */
  example: string | null;
  /** The file name for a new test from a short id: "tewip-ls-002.spec.ts", "test_tewip_ls_002.py", "TewipLs002Test.java". */
  fileFor(id: string): string;
  /** The shell command that runs just this test file, from `cwd`. */
  command(file: string): string;
  /** Extra environment for the runner, e.g. a browser for Karma. */
  env?: Record<string, string>;
}

/**
 * A Chrome for Karma when CHROME_BIN is not set: the Chromium Playwright installed, if any. Karma
 * cannot start without one, and many machines have Playwright's browsers but no Chrome.
 */
function karmaChrome(): Record<string, string> {
  if (process.env.CHROME_BIN) return {};
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright') : process.platform === 'darwin' ? join(home, 'Library', 'Caches', 'ms-playwright') : join(home, '.cache', 'ms-playwright'));
  if (!existsSync(root)) return {};
  const builds = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const exe = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'];
  for (const build of builds) for (const e of exe) if (existsSync(join(root, build, e))) return { CHROME_BIN: join(root, build, e) };
  return {};
}

const SKIP = new Set(['node_modules', '.git', '.tewip', 'dist', 'build', 'target', 'venv', '.venv', '__pycache__', 'bin', 'obj', 'vendor']);
const q = (s: string) => `"${s}"`;
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function dirs(root: string, depth = 2): string[] {
  const out = [root];
  if (depth === 0) return out;
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(...dirs(p, depth - 1));
  }
  return out;
}

/** Test files under `dir` whose names match, newest-looking first (shortest path wins ties). */
function testFiles(dir: string, match: RegExp, depth = 6): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...testFiles(p, match, depth - 1));
    else if (match.test(name) && !/tewip/i.test(name)) out.push(p);
  }
  return out.sort((a, b) => a.length - b.length);
}

const kebab = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pascal = (id: string) => kebab(id).split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

/** "tewip-<id><suffix>", with the suffix the project's own tests use. */
function sameSuffix(example: string | null, fallback: string, known: RegExp): (id: string) => string {
  const suffix = example?.match(known)?.[0] ?? fallback;
  return (id) => `tewip-${kebab(id)}${suffix}`;
}

function jsFramework(dir: string, deps: string): Framework | null {
  const config = (names: string[]) => names.map((n) => join(dir, n)).find(existsSync);
  const pw = config(['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']);
  if (pw) {
    const testDir = join(dir, read(pw).match(/testDir:\s*['"`]([^'"`]+)/)?.[1] ?? '.');
    const example = testFiles(testDir, /\.(spec|test)\.[mc]?[jt]s$/)[0] ?? null;
    return { id: 'playwright', label: 'Playwright Test (TypeScript/JavaScript)', browser: true, cwd: dir, testDir: example ? dirname(example) : testDir, example, fileFor: sameSuffix(example, '.spec.ts', /\.(spec|test)\.[mc]?[jt]s$/), command: (f) => `npx playwright test ${q(relative(dir, f).replaceAll('\\', '/'))} --retries=0 --workers=1 --reporter=line` };
  }
  const cy = config(['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs']);
  if (cy) {
    const example = testFiles(join(dir, 'cypress'), /\.cy\.[jt]sx?$/)[0] ?? null;
    return { id: 'cypress', label: 'Cypress (JavaScript/TypeScript)', browser: true, cwd: dir, testDir: example ? dirname(example) : join(dir, 'cypress', 'e2e'), example, fileFor: sameSuffix(example, '.cy.ts', /\.cy\.[jt]sx?$/), command: (f) => `npx cypress run --spec ${q(relative(dir, f))}` };
  }
  const wdio = config(['wdio.conf.ts', 'wdio.conf.js']);
  if (wdio) {
    const example = testFiles(dir, /\.(e2e|spec|test)\.[jt]s$/)[0] ?? null;
    return { id: 'webdriverio', label: 'WebdriverIO (JavaScript/TypeScript)', browser: true, cwd: dir, testDir: example ? dirname(example) : join(dir, 'test', 'specs'), example, fileFor: sameSuffix(example, '.e2e.ts', /\.(e2e|spec|test)\.[jt]s$/), command: (f) => `npx wdio run ${q(basename(wdio))} --spec ${q(relative(dir, f))}` };
  }
  // Angular runs its unit tests through the CLI (Karma with Jasmine, or the Vitest-based unit-test
  // builder), with the project's TestBed setup, so a spec must run through `ng test` as well.
  const angular = read(join(dir, 'angular.json'));
  const builder = angular.match(/"test"\s*:\s*\{\s*"builder"\s*:\s*"([^"]+)"/)?.[1] ?? '';
  if (angular && /karma|unit-test/.test(builder)) {
    const example = testFiles(join(dir, 'src'), /\.spec\.ts$/)[0] ?? null;
    const karma = builder.includes('karma');
    return {
      id: 'angular',
      label: `Angular (ng test with ${karma ? 'Karma and Jasmine' : 'Vitest'}, TestBed; TypeScript)`,
      browser: false,
      cwd: dir,
      testDir: example ? dirname(example) : join(dir, 'src', 'app'),
      example,
      fileFor: (id) => `tewip-${kebab(id)}.spec.ts`,
      command: (f) => `npx ng test --watch=false --include=${q(relative(dir, f).replaceAll('\\', '/'))}${karma ? ' --browsers=ChromeHeadless' : ''}`,
    };
  }
  for (const id of ['vitest', 'jest'] as const) {
    if (!new RegExp(`"${id}"\\s*:`).test(deps)) continue;
    const example = testFiles(dir, /\.(spec|test)\.[mc]?[jt]sx?$/)[0] ?? null;
    const browser = /"selenium-webdriver"\s*:|"puppeteer"\s*:/.test(deps);
    // Name the UI library and Testing Library, so component tests are written the way this project writes them.
    const ui = [['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['solid-js', 'Solid'], ['@angular/core', 'Angular']].filter(([dep]) => new RegExp(`"${dep}"\\s*:`).test(deps)).map(([, name]) => name);
    const testingLibrary = /"@testing-library\/[\w-]+"\s*:/.test(deps) ? ' and Testing Library' : '';
    const label = `${id === 'jest' ? 'Jest' : 'Vitest'}${browser ? ' with Selenium/Puppeteer' : ''}${ui.length ? ` for ${ui.join('/')}${testingLibrary}` : ''} (JavaScript/TypeScript)`;
    const run = id === 'jest' ? 'npx jest' : 'npx vitest run';
    return { id, label, browser, cwd: dir, testDir: example ? dirname(example) : join(dir, 'test'), example, fileFor: sameSuffix(example, '.test.ts', /\.(spec|test)\.[mc]?[jt]sx?$/), command: (f) => `${run} ${q(relative(dir, f).replaceAll('\\', '/'))}` };
  }
  return null;
}

/** The project's own Python (its virtual environment) when it has one, else the one on the PATH. */
function pythonOf(dir: string): string {
  for (const env of ['.venv', 'venv', 'env']) {
    for (const bin of process.platform === 'win32' ? ['Scripts/python.exe'] : ['bin/python']) {
      if (existsSync(join(dir, env, bin))) return join(dir, env, bin);
    }
  }
  return 'python';
}

function otherFramework(dir: string): Framework | null {
  const py = ['pytest.ini', 'conftest.py', 'pyproject.toml', 'requirements.txt', 'setup.cfg', 'tox.ini'].map((n) => read(join(dir, n))).join('\n');
  const pyExample = testFiles(dir, /^test_.*\.py$|_test\.py$/)[0] ?? null;
  if (pyExample && (/pytest/i.test(py) || existsSync(join(dir, 'conftest.py')))) {
    const lib = /selenium/i.test(py) ? ' with Selenium' : /playwright/i.test(py) ? ' with Playwright' : '';
    return { id: 'pytest', label: `pytest${lib} (Python)`, browser: lib !== '', cwd: dir, testDir: dirname(pyExample), example: pyExample, fileFor: (id) => `test_tewip_${kebab(id).replaceAll('-', '_')}.py`, command: (f) => `${q(pythonOf(dir))} -m pytest ${q(relative(dir, f))} -q -p no:cacheprovider` };
  }
  const javaExample = testFiles(join(dir, 'src', 'test'), /Tests?\.(java|kt)$/)[0] ?? null;
  const pom = read(join(dir, 'pom.xml'));
  const gradle = read(join(dir, 'build.gradle')) + read(join(dir, 'build.gradle.kts'));
  if (javaExample && (pom || gradle)) {
    const build = pom || gradle;
    const lib = /selenium/i.test(build) ? ' with Selenium' : /spring-boot-starter-test/.test(build) ? ' on Spring Boot' : '';
    const cls = (f: string) => basename(f).replace(/\.(java|kt)$/, '');
    const lang = javaExample.endsWith('.kt') ? 'Kotlin' : 'Java';
    const wrapper = existsSync(join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')) ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew') : 'gradle';
    return pom
      ? { id: 'maven', label: `JUnit via Maven${lib} (${lang})`, browser: lib === ' with Selenium', cwd: dir, testDir: dirname(javaExample), example: javaExample, fileFor: (id) => `Tewip${pascal(id)}Test.${javaExample.endsWith('.kt') ? 'kt' : 'java'}`, command: (f) => `mvn -q test -Dtest=${cls(f)} -Dsurefire.failIfNoSpecifiedTests=false` }
      : { id: 'gradle', label: `JUnit via Gradle${lib} (${lang})`, browser: lib === ' with Selenium', cwd: dir, testDir: dirname(javaExample), example: javaExample, fileFor: (id) => `Tewip${pascal(id)}Test.${javaExample.endsWith('.kt') ? 'kt' : 'java'}`, command: (f) => `${wrapper} test --tests ${cls(f)}` };
  }
  const csproj = readdirSync(dir).find((n) => n.endsWith('.csproj') && /Microsoft\.NET\.Test\.Sdk/.test(read(join(dir, n))));
  if (csproj) {
    const example = testFiles(dir, /Tests?\.cs$/)[0] ?? null;
    const lib = /Selenium/.test(read(join(dir, csproj))) ? ' with Selenium' : /Playwright/.test(read(join(dir, csproj))) ? ' with Playwright' : '';
    return { id: 'dotnet', label: `.NET test${lib} (C#)`, browser: lib !== '', cwd: dir, testDir: example ? dirname(example) : dir, example, fileFor: (id) => `Tewip${pascal(id)}Tests.cs`, command: (f) => `dotnet test --filter FullyQualifiedName~${basename(f, '.cs')}` };
  }
  if (existsSync(join(dir, 'go.mod'))) {
    const example = testFiles(dir, /_test\.go$/)[0] ?? null;
    if (example) return { id: 'go', label: 'Go testing', browser: false, cwd: dir, testDir: dirname(example), example, fileFor: (id) => `tewip_${kebab(id).replaceAll('-', '_')}_test.go`, command: (f) => `go test ./${relative(dir, dirname(f)).replaceAll('\\', '/') || '.'}` };
  }
  return null;
}

/** Every test framework found in the project, browser frameworks first. */
export function detectFrameworks(root: string): Framework[] {
  const found: Framework[] = [];
  for (const dir of dirs(root)) {
    const deps = read(join(dir, 'package.json'));
    for (const f of [jsFramework(dir, deps), otherFramework(dir)]) if (f && !found.some((x) => x.id === f.id && x.cwd === f.cwd)) found.push(f);
  }
  return found.sort((a, b) => Number(b.browser) - Number(a.browser));
}

/** The framework to write in: the one asked for, else the first browser framework, else the first. */
export function chooseFramework(found: Framework[], wanted?: string): Framework | null {
  if (wanted) return found.find((f) => f.id === wanted) ?? null;
  return found[0] ?? null;
}
