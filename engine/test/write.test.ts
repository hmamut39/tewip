// Unit tests for `tewip write`: finding the project's framework, and the rules that decide whether
// a drafted test is kept. The model and the test runs are faked; what is tested is the judging.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LlmClient } from '../llm/client.ts';
import { chooseFramework, detectFrameworks, type Framework } from '../quality/frameworks.ts';
import { mutate, type Draft, type Scenario } from '../quality/write.ts';
import { writeAndVerify, type RunResult } from '../quality/write-verify.ts';

function files(tree: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-write-'));
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('finding the framework to write in', () => {
  it('finds Playwright in a subfolder and pytest at the root, browser tests first', () => {
    const root = files({
      'e2e/playwright.config.ts': "export default { testDir: './tests' };",
      'e2e/tests/app.spec.ts': "test('x', () => {});",
      'requirements.txt': 'pytest\nfastapi\n',
      'tests/test_api.py': 'def test_x(): pass',
    });
    const found = detectFrameworks(root);
    assert.deepEqual(found.map((f) => f.id), ['playwright', 'pytest']);
    const pw = chooseFramework(found)!;
    assert.equal(pw.testDir, join(root, 'e2e', 'tests'));
    assert.equal(pw.fileFor('LS-002'), 'tewip-ls-002.spec.ts');
    assert.match(pw.command(join(pw.testDir, 'tewip-ls-002.spec.ts')), /^npx playwright test "tests\/tewip-ls-002\.spec\.ts" --retries=0/);
    assert.equal(chooseFramework(found, 'pytest')!.fileFor('LS-002'), 'test_tewip_ls_002.py');
  });

  it('reads Selenium on Maven, with a class name that matches the file', () => {
    const root = files({ 'pom.xml': '<artifactId>selenium-java</artifactId>', 'src/test/java/com/shop/LoginTest.java': 'class LoginTest {}' });
    const f = chooseFramework(detectFrameworks(root))!;
    assert.equal(f.id, 'maven');
    assert.equal(f.label, 'JUnit via Maven with Selenium (Java)');
    assert.equal(f.browser, true);
    assert.equal(f.fileFor('LS-002'), 'TewipLs002Test.java');
    assert.match(f.command(join(f.testDir, 'TewipLs002Test.java')), /-Dtest=TewipLs002Test /);
  });

  it('finds Cypress, and never takes its own earlier tests as the style example', () => {
    const root = files({ 'cypress.config.ts': '', 'cypress/e2e/tewip-a.cy.ts': '', 'cypress/e2e/login.cy.ts': '' });
    const f = chooseFramework(detectFrameworks(root))!;
    assert.equal(f.id, 'cypress');
    assert.equal(f.example, join(root, 'cypress', 'e2e', 'login.cy.ts'));
  });

  it('says nothing was found rather than guessing', () => {
    assert.equal(chooseFramework(detectFrameworks(files({ 'README.md': '' }))), null);
  });
});

const CODE = "test('search', async ({ page }) => {\n  await page.goto('/library');\n  await expect(page.getByText('3 results')).toBeVisible();\n});\n";
const draft = (mutation: Draft['mutation'], code = CODE): Draft => ({ code, checks: 'three results show', mutation });

describe('the broken-on-purpose version', () => {
  it('changes the expected value inside the check', () => {
    const m = mutate(draft({ find: "'3 results'", replace: "'4 results'" }));
    assert.ok('code' in m && m.code.includes("getByText('4 results')"));
  });

  it('refuses a change outside a check, a missing piece, or no change at all', () => {
    assert.match((mutate(draft({ find: "'/library'", replace: "'/home'" })) as { problem: string }).problem, /not in a check/);
    assert.match((mutate(draft({ find: 'nowhere', replace: 'x' })) as { problem: string }).problem, /is not in the test/);
    assert.match((mutate(draft({ find: "'3 results'", replace: "'3 results'" })) as { problem: string }).problem, /changes nothing/);
  });
});

const FRAMEWORK = { id: 'playwright', label: 'Playwright', browser: true, cwd: '.', testDir: '.', example: null, fileFor: (id: string) => id, command: () => '' } as Framework;
const SCENARIO: Scenario = { id: 'LS-002', title: 'search', type: 'functional', priority: 'P0', preconditions: '', steps: [], expected: 'three results', automate: true, covered_by: '', grounded_on: '' };

/** A model that answers from a queue, and a runner that passes or fails by what the file contains. */
function fakes(answers: object[], passes: (code: string) => boolean) {
  const model: LlmClient = { model: 'fake', complete: async () => JSON.stringify(answers.shift()) } as LlmClient;
  const dir = mkdtempSync(join(tmpdir(), 'tewip-run-'));
  const file = join(dir, 'tewip-ls-002.spec.ts');
  const run = (_f: Framework, path: string): RunResult => ({ passed: passes(readFileSync(path, 'utf8')), output: 'Error: expect(locator).toBeVisible() failed' });
  const go = (runs = 3) => writeAndVerify(model, { framework: FRAMEWORK, fileName: 'x', pages: [], feature: 'f' }, SCENARIO, file, { runs, repairs: 2, run });
  return { go, file };
}

describe('deciding whether a drafted test is kept', () => {
  const GOOD = draft({ find: "'3 results'", replace: "'4 results'" });

  it('keeps a test that passes every run and fails when its check is broken', async () => {
    const { go, file } = fakes([GOOD], (code) => code.includes("'3 results'"));
    const { outcome } = await go();
    assert.equal(outcome.kind, 'kept');
    assert.equal(readFileSync(file, 'utf8'), CODE, 'the file ends as the real test, not the broken one');
  });

  it('drops a test that still passes with its check broken: it cannot catch the bug', async () => {
    const { go } = fakes([GOOD], () => true);
    const { outcome } = await go();
    assert.equal(outcome.kind, 'rejected');
    assert.match((outcome as { reason: string }).reason, /still passes with its check broken/);
  });

  it('drops a flaky test', async () => {
    let n = 0;
    const { go } = fakes([GOOD], () => ++n !== 2);
    assert.match(((await go()).outcome as { reason: string }).reason, /flaky/);
  });

  it('repairs from the real error, and reports a possible bug instead of weakening the check', async () => {
    const repaired = { ...draft({ find: "'3 results'", replace: "'4 results'" }, CODE.replace('/library', '/library?q=a')), fault: 'test', reason: 'wrong path' };
    const kept = fakes([draft({ find: "'3 results'", replace: "'4 results'" }, CODE.replace('/library', '/lib')), repaired], (code) => code.includes('?q=a') && code.includes("'3 results'"));
    const k = await kept.go();
    assert.equal(k.outcome.kind, 'kept');
    assert.equal((k.outcome as { repairs: number }).repairs, 1);

    const bug = fakes([GOOD, { ...GOOD, fault: 'app', reason: 'the page shows 0 results for a word the library has', observed: 'expect(locator).toBeVisible() failed' }], () => false);
    const b = await bug.go();
    assert.equal(b.outcome.kind, 'possible-bug');
    assert.match((b.outcome as { reason: string }).reason, /0 results/);

    // Blaming the app with a quote the run never printed is not a bug report.
    const unfounded = fakes([GOOD, { ...GOOD, fault: 'app', reason: 'the heading is missing', observed: 'No heading on the page' }], () => false);
    const u = await unfounded.go();
    assert.equal(u.outcome.kind, 'rejected');
    assert.match((u.outcome as { reason: string }).reason, /could not quote/);

    // A bare label is in every failure: it is not evidence.
    const bare = fakes([GOOD, { ...GOOD, fault: 'app', reason: 'no pressed state', observed: 'Error:' }], () => false);
    assert.equal((await bare.go()).outcome.kind, 'rejected');
  });

  it('gives up after the allowed repairs and says so', async () => {
    const { go } = fakes([GOOD, { ...GOOD, fault: 'test', reason: '' }, { ...GOOD, fault: 'test', reason: '' }], () => false);
    assert.match(((await go()).outcome as { reason: string }).reason, /still failing after 2 repair/);
  });
});

describe('a run where every test skipped', () => {
  it('is not a pass, in any runner', async () => {
    const { onlySkipped } = await import('../quality/write-verify.ts');
    assert.equal(onlySkipped('  1 skipped\n'), true);
    assert.equal(onlySkipped('1 skipped, 1 passed'), false);
    assert.equal(onlySkipped('0 passing (2ms)\n  1 pending'), true);
    assert.equal(onlySkipped('Tests run: 1, Failures: 0, Errors: 0, Skipped: 1'), true);
    assert.equal(onlySkipped('Tests run: 2, Failures: 0, Errors: 0, Skipped: 1'), false);
    assert.equal(onlySkipped('1 passed (3.1s)'), false);
    assert.equal(onlySkipped('Chrome Headless 153 (Windows 10): Executed 0 of 1 (skipped 1) SUCCESS'), true);
    assert.equal(onlySkipped('Chrome Headless 153 (Windows 10): Executed 2 of 3 (skipped 1) SUCCESS'), false);
  });

  it('never counts as proof that a test can fail', async () => {
    const answers = [draft({ find: "'3 results'", replace: "'4 results'" })];
    const model = { model: 'fake', complete: async () => JSON.stringify(answers.shift()) } as LlmClient;
    const file = join(mkdtempSync(join(tmpdir(), 'tewip-run-')), 't.spec.ts');
    const run = (_f: Framework, path: string): RunResult => (readFileSync(path, 'utf8').includes("'3 results'") ? { passed: true, output: '1 passed' } : { passed: false, skipped: true, output: '1 skipped' });
    const { outcome } = await writeAndVerify(model, { framework: FRAMEWORK, fileName: 'x', pages: [], feature: 'f' }, SCENARIO, file, { runs: 1, repairs: 0, run });
    assert.match((outcome as { reason: string }).reason, /broken version was skipped/);
  });
});

describe('checks that may break when the data changes', () => {
  it('flags a hard-coded count in an expected text, not a timeout or a status', async () => {
    const { brittleChecks } = await import('../quality/write.ts');
    const code = [
      "await expect(page.getByText('21 books · 7236 passages searchable')).toBeVisible();",
      "await expect(page.getByText(/\d+ books/)).toBeVisible({ timeout: 10000 });",
      'expect(response.status()).toBeLessThan(500);',
      "await expect(page.getByText('page 12')).toBeVisible();",
    ].join('\n');
    assert.deepEqual(brittleChecks(code), ["await expect(page.getByText('21 books · 7236 passages searchable')).toBeVisible();"]);
  });
});

describe('placing the deliberate break', () => {
  it('uses the one place inside a check when the value also appears as input', () => {
    const code = "const input = 'a%26b';\nexpect(parse(input)).toEqual('a%26b');\n";
    const m = mutate({ code, checks: '', mutation: { find: "'a%26b'", replace: "'zzz'" } });
    assert.ok('code' in m && m.code === "const input = 'a%26b';\nexpect(parse(input)).toEqual('zzz');\n");
  });

  it('counts the expected column of a table-driven test as a check', () => {
    const code = "const cases = [\n  { input: '/?a=1', out: '/?a=2' },\n];\n";
    const m = mutate({ code, checks: '', mutation: { find: "out: '/?a=2'", replace: "out: '/?a=3'" } });
    assert.ok('code' in m);
  });
});

describe('a check written over several lines', () => {
  it('finds the expected value on the line under `out:` or inside a multi-line expect', () => {
    const table = "const cases = [\n  {\n    input: '/page',\n    out:\n      '/page?a=1',\n  },\n];\n";
    assert.ok('code' in mutate({ code: table, checks: '', mutation: { find: "'/page?a=1'", replace: "'/page?a=2'" } }));
    const multi = "expect(\n  withQuery('/page', { a: 1 }),\n).toBe(\n  '/page?a=1',\n);\n";
    assert.ok('code' in mutate({ code: multi, checks: '', mutation: { find: "'/page?a=1'", replace: "'/x'" } }));
  });
});

describe('checks in Python style', () => {
  it('counts pytest.raises and a comparison line of a multi-line assert as checks', () => {
    const raises = 'def test_x():\n    with pytest.raises(ValueError):\n        naturalsize("not-a-number")\n';
    assert.ok('code' in mutate({ code: raises, checks: '', mutation: { find: 'ValueError', replace: 'KeyError' } }));
    const multi = 'def test_y():\n    assert (\n        intcomma("12x34"),\n        intcomma("abc"),\n    ) == ("12x34", "abc")\n';
    assert.ok('code' in mutate({ code: multi, checks: '', mutation: { find: '("12x34", "abc")', replace: '("x", "abc")' } }));
  });
});

describe('front-end projects', () => {
  it('runs Angular specs through ng test, Karma or the Vitest builder', () => {
    const karma = files({ 'angular.json': '{"projects":{"app":{"architect":{"test":{"builder":"@angular-devkit/build-angular:karma"}}}}}', 'src/app/app.component.spec.ts': '', 'package.json': '{"devDependencies":{"jasmine-core":"5"}}' });
    const a = chooseFramework(detectFrameworks(karma))!;
    assert.equal(a.id, 'angular');
    assert.match(a.label, /Karma and Jasmine/);
    assert.equal(a.testDir, join(karma, 'src', 'app'));
    assert.match(a.command(join(a.testDir, 'tewip-x.spec.ts')), /^npx ng test --watch=false --include="src\/app\/tewip-x\.spec\.ts" --browsers=ChromeHeadless$/);
    const vitest = files({ 'angular.json': '{"test": {"builder": "@angular/build:unit-test"}}', 'src/app/a.spec.ts': '' });
    assert.match(chooseFramework(detectFrameworks(vitest))!.label, /ng test with Vitest/);
  });

  it('names React and Testing Library for a Vitest project, so component tests follow them', () => {
    const root = files({ 'package.json': '{"dependencies":{"react":"19"},"devDependencies":{"vitest":"4","@testing-library/react":"16"}}', 'src/App.test.tsx': '' });
    assert.match(chooseFramework(detectFrameworks(root))!.label, /^Vitest for React and Testing Library/);
  });
});

describe('a project with both e2e and unit tests', () => {
  it('finds both, and picks by the kind of test: pages mean the browser, none mean the unit framework', () => {
    const root = files({
      'playwright.config.ts': "export default { testDir: './e2e' };",
      'e2e/home.spec.ts': '',
      'package.json': '{"dependencies":{"react":"19"},"devDependencies":{"@playwright/test":"1","vitest":"4"}}',
      'components/Vote.test.tsx': '',
    });
    const found = detectFrameworks(root);
    assert.deepEqual(found.map((f) => f.id), ['playwright', 'vitest']);
    assert.equal(chooseFramework(found, undefined, true)!.id, 'playwright');
    assert.equal(chooseFramework(found, undefined, false)!.id, 'vitest');
  });
});

describe('when the test runner itself breaks', () => {
  it('names the environment instead of calling the test flaky', async () => {
    const answers = [draft({ find: "'3 results'", replace: "'4 results'" })];
    const model = { model: 'fake', complete: async () => JSON.stringify(answers.shift()) } as LlmClient;
    const file = join(mkdtempSync(join(tmpdir(), 'tewip-run-')), 't.spec.ts');
    let n = 0;
    const run = (): RunResult => (++n === 1 ? { passed: true, output: '1 passed' } : { passed: false, environment: true, output: 'WARN [launcher]: ChromeHeadless has not captured in 60000 ms, killing.' });
    const { outcome } = await writeAndVerify(model, { framework: FRAMEWORK, fileName: 'x', pages: [], feature: 'f' }, SCENARIO, file, { runs: 3, repairs: 0, run });
    assert.equal(outcome.kind, 'rejected');
    assert.match((outcome as { reason: string }).reason, /environment/);
    assert.doesNotMatch((outcome as { reason: string }).reason, /flaky/);
  });
});
