// Fixing a drifted selector in Cypress, Selenium or WebdriverIO - the tools that give Tewip no page
// snapshot. The replacement can only come from the repository, so these tests are mostly about what
// happens when the repository does not know either: Tewip says so and changes nothing.
//
// The git test is a real repository, created and committed here, because the whole point is reading
// a real rename out of real history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { PlannedAction } from '../decide.ts';
import { attemptSelectorFix, findSelectorSites, selectorFixDiff } from '../autofix/fix-selector.ts';
import { closeness, likeItInSource, renamedInGit, tokenOf, writeSelector } from '../autofix/selector-source.ts';

const NL = String.fromCharCode(10);
const lines = (...l: string[]) => l.join(NL);

const DRIFT: Diagnosis = { category: 'LOCATOR_DRIFT', confidence: 0.9 } as Diagnosis;
const FIX_LOCATOR: PlannedAction = { kind: 'fix-locator', autonomous: true } as PlannedAction;

const record = (message: string): TriageRecord =>
  ({ schemaVersion: 1, testId: 'checkout > pays', file: 'cypress/e2e/checkout.cy.ts', status: 'failed', errorMessage: message, errorStack: '', duration: 1, retry: 0, attachments: [], runId: 'r', gitSha: '', timestamp: new Date().toISOString() }) as unknown as TriageRecord;

const CYPRESS_ERROR = "Timed out retrying after 4000ms: Expected to find element: '#submit-btn', but never found it.";
const SELENIUM_ERROR = 'no such element: Unable to locate element: {"method":"css selector","selector":"#submit-btn"}';

describe('reading what the test was looking for', () => {
  it('knows an id, a class and a data attribute from anything else', () => {
    assert.deepEqual(tokenOf('#submit-btn'), { kind: 'id', value: 'submit-btn' });
    assert.deepEqual(tokenOf('.cart-total'), { kind: 'class', value: 'cart-total' });
    assert.deepEqual(tokenOf('[data-cy="pay"]'), { kind: 'data', attribute: 'data-cy', value: 'pay' });
    assert.equal(tokenOf('div > span:nth-child(2)'), null, 'nothing in the source to compare that against');
  });

  it('writes the replacement the way each kind is written', () => {
    assert.equal(writeSelector({ kind: 'id', value: 'submit-button' }, 'submit-button'), '#submit-button');
    assert.equal(writeSelector({ kind: 'data', attribute: 'data-cy', value: 'pay' }, 'pay-now'), '[data-cy="pay-now"]');
  });

  it('measures how close two names are, including a shared prefix', () => {
    assert.ok(closeness('submit-btn', 'submit-button') >= 0.5);
    assert.ok(closeness('submitBtn', 'submitButton') >= 0.5, 'no shared word, but a long shared start');
    assert.ok(closeness('submit-btn', 'cancel-link') < 0.5);
  });

  it('finds the selector in the test, in whichever quotes it was written', () => {
    const source = lines("cy.get('#submit-btn').click();", 'cy.get("#other").click();');
    assert.deepEqual(findSelectorSites(source, '#submit-btn'), [{ line: 1, text: "cy.get('#submit-btn').click();" }]);
  });
});

describe('finding the new name in the repository', () => {
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), 'tewip-selector-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'Checkout.jsx'), lines('export const Checkout = () => (', '  <button id="submit-btn">Pay</button>', ');'), 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'checkout');
    // The rename a developer really made.
    writeFileSync(join(root, 'src', 'Checkout.jsx'), lines('export const Checkout = () => (', '  <button id="submit-button">Pay</button>', ');'), 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'rename the submit button');
    return root;
  }

  it('reads the rename out of the commit that made it', () => {
    const root = repo();
    const found = renamedInGit(root, { kind: 'id', value: 'submit-btn' });
    assert.equal(found?.value, 'submit-button');
    assert.equal(found?.how, 'renamed in git');
    assert.match(found?.file ?? '', /Checkout\.jsx/);
    assert.ok((found?.commit ?? '').length >= 7, 'the commit is named, so a person can check it');
  });

  it('falls back to what the source says now, but only when it is clearly close', () => {
    const root = repo();
    const source = join(root, 'src', 'Checkout.jsx');
    assert.equal(likeItInSource(root, { kind: 'id', value: 'submit-btn' }, [source])?.value, 'submit-button');
    assert.equal(likeItInSource(root, { kind: 'id', value: 'totally-different-thing' }, [source]), null, 'nothing close enough is not a rename');
    assert.equal(likeItInSource(root, { kind: 'id', value: 'submit-button' }, [source]), null, 'it is still there, so nothing drifted');
  });
});

describe('the fix itself', () => {
  function project(testSource: string) {
    const root = mkdtempSync(join(tmpdir(), 'tewip-fix-sel-'));
    mkdirSync(join(root, 'cypress', 'e2e'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    const spec = join(root, 'cypress', 'e2e', 'checkout.cy.ts');
    const app = join(root, 'src', 'Checkout.jsx');
    writeFileSync(spec, testSource, 'utf8');
    writeFileSync(app, '<button id="submit-button">Pay</button>', 'utf8');
    return { root, spec, app };
  }

  const deps = (root: string, app: string, passes: boolean) => ({
    allowedRoot: root,
    projectRoot: root,
    sources: [app],
    readFile: (p: string) => readFileSync(p, 'utf8'),
    writeFile: (p: string, c: string) => writeFileSync(p, c, 'utf8'),
    verify: async () => ({ passed: passes, detail: passes ? 'passed' : 'still not found' }),
  });

  it('replaces the selector, keeps it when the test passes, and says where the name came from', async () => {
    const { root, spec, app } = project(lines("describe('checkout', () => {", "  it('pays', () => {", "    cy.get('#submit-btn').click();", '  });', '});'));
    const result = await attemptSelectorFix({ record: record(CYPRESS_ERROR), diagnosis: DRIFT, action: FIX_LOCATOR, specFile: spec }, deps(root, app, true));
    assert.equal(result.status, 'fixed');
    assert.match(readFileSync(spec, 'utf8'), /cy\.get\('#submit-button'\)/);
    assert.match(result.evidence ?? '', /now has "submit-button"/);
    assert.match(selectorFixDiff(result), /-\s*cy\.get\('#submit-btn'\)/);
  });

  it('reads a Selenium error as well as a Cypress one', async () => {
    const { root, spec, app } = project("driver.findElement(By.cssSelector('#submit-btn')).click();");
    const result = await attemptSelectorFix({ record: record(SELENIUM_ERROR), diagnosis: DRIFT, action: FIX_LOCATOR, specFile: spec }, deps(root, app, true));
    assert.equal(result.status, 'fixed');
    assert.match(readFileSync(spec, 'utf8'), /#submit-button/);
  });

  it('puts the file back when the test still fails', async () => {
    const source = "cy.get('#submit-btn').click();";
    const { root, spec, app } = project(source);
    const result = await attemptSelectorFix({ record: record(CYPRESS_ERROR), diagnosis: DRIFT, action: FIX_LOCATOR, specFile: spec }, deps(root, app, false));
    assert.equal(result.status, 'still-failing');
    assert.equal(readFileSync(spec, 'utf8'), source, 'byte for byte as it was');
  });

  it('refuses to invent a selector when the repository does not know either', async () => {
    const { root, spec } = project("cy.get('#submit-btn').click();");
    const result = await attemptSelectorFix({ record: record(CYPRESS_ERROR), diagnosis: DRIFT, action: FIX_LOCATOR, specFile: spec }, deps(root, join(root, 'nothing.jsx'), true));
    assert.equal(result.status, 'no-replacement');
    assert.match(result.log.join(' '), /will not invent a selector/);
  });

  it('says a positional selector is not something it can check', async () => {
    const { root, spec, app } = project("cy.get('div > span:nth-child(2)').click();");
    const message = "Timed out retrying after 4000ms: Expected to find element: 'div > span:nth-child(2)', but never found it.";
    const result = await attemptSelectorFix({ record: record(message), diagnosis: DRIFT, action: FIX_LOCATOR, specFile: spec }, deps(root, app, true));
    assert.equal(result.status, 'not-identifiable');
    assert.match(result.log.join(' '), /A person should look at the page/);
  });

  it('does not touch a test for a failure that is not drift', async () => {
    const { root, spec, app } = project("cy.get('#submit-btn').click();");
    const notDrift = { category: 'TIMING', confidence: 0.9 } as Diagnosis;
    const result = await attemptSelectorFix({ record: record(CYPRESS_ERROR), diagnosis: notDrift, action: FIX_LOCATOR, specFile: spec }, deps(root, app, true));
    assert.equal(result.status, 'not-eligible');
  });
});
