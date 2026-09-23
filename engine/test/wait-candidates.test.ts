// Every case here comes from a real commit in which a developer removed one fixed wait from a test.
// 60 such commits were harvested from 47 public repositories and run through this code, and each
// group below is a way it was wrong on real code that no synthetic example had shown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findFixedWaits, waitFixCandidates } from '../autofix/waits.ts';
import { nextStepRetries, thingToWaitFor } from '../autofix/wait-candidates.ts';
import { hasAssertionAfter } from '../autofix/locate.ts';

const NL = String.fromCharCode(10);
const file = (...lines: string[]) => lines.join(NL);

describe('finding a fixed wait as people really write it', () => {
  it('finds one that carries a trailing comment', () => {
    // `cy.wait(500); // eslint-disable-line` is written *because* the line is a fixed wait, so
    // requiring the line to end after the call refused the clearest cases of all: 15 of 60.
    const found = findFixedWaits(
      file('await page.waitForTimeout(300); // allow debounce', "cy.wait(500); // eslint-disable-line cypress/no-unnecessary-waiting", 'await page.waitForTimeout(50) // give the listener a tick'),
    );
    assert.equal(found.length, 3);
    assert.deepEqual(found.map((w) => w.ms), [300, 500, 50]);
  });

  it('reads numeric separators, which are ordinary JavaScript', () => {
    const [wait] = findFixedWaits('await page.waitForTimeout(3_000);');
    assert.equal(wait.ms, 3000);
  });

  it('finds the hand-rolled sleep people write when there is no helper', () => {
    const [wait] = findFixedWaits('  await new Promise(resolve => setTimeout(resolve, 500))');
    assert.equal(wait.ms, 500);
    assert.equal(wait.indent, '  ');
  });

  it('still refuses a line that only looks like a wait', () => {
    assert.deepEqual(findFixedWaits(file('await page.waitForTimeout(ms);', 'const delay = 500;', 'setTimeout(done, 500);')), []);
  });
});

describe('deleting a fixed wait only where the next step waits by itself', () => {
  it('deletes it in front of a step that retries', () => {
    for (const next of [
      "await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();",
      "await page.getByRole('button', { name: 'Pay' }).click();",
      "await this.cancelCreateBtn().waitFor({ state: 'visible' });",
      'await page.goto("/admin/students");',
    ]) {
      assert.equal(nextStepRetries(next, 'playwright'), true, next);
    }
  });

  it('refuses to delete it in front of a step that reads a value once', () => {
    // These were common in the real commits. `page.url()` and `.count()` do not retry, so the
    // fixed wait may be the only thing making the read reliable - and because a race passes by
    // luck, even three passing runs would not catch its removal.
    for (const next of [
      'const currentUrl = page.url()',
      'expect(page.url()).toBe(currentUrl);',
      "const insCount = await page.locator('#diff-output ins').count();",
      'if (await submitButton.isEnabled()) {',
      'expect(await page.notebook.isCellInEditingMode(0)).toBeFalsy();',
    ]) {
      assert.equal(nextStepRetries(next, 'playwright'), false, next);
    }
  });

  it('offers nothing at all when the next step neither waits nor names an element', () => {
    const source = file("test('x', async ({ page }) => {", '  await page.waitForTimeout(500);', '  const currentUrl = page.url()', '  expect(currentUrl).toContain("/home");', '});');
    const [site] = findFixedWaits(source);
    assert.deepEqual(waitFixCandidates(source, site, 'playwright'), [], 'a developer here waited for the URL, which Tewip cannot invent');
  });

  it('offers deletion first and an explicit wait as a fallback', () => {
    const source = file("test('x', async ({ page }) => {", '  await page.waitForTimeout(500);', "  await page.getByRole('button', { name: 'Pay' }).click();", "  await expect(page.getByText('Done')).toBeVisible();", '});');
    const [site] = findFixedWaits(source);
    const candidates = waitFixCandidates(source, site, 'playwright');
    assert.equal(candidates[0].replacement, '', 'deleting is the smallest change');
    assert.match(candidates[1].replacement, /await expect\(page\.getByRole\('button', \{ name: 'Pay' \}\)\)\.toBeVisible\(\);/);
  });
});

describe('Cypress, whose tests read nothing like Playwright ones', () => {
  it('counts should() as checking something', () => {
    // Six real Cypress removals were refused as "nothing is asserted after the wait" when the very
    // next line was the assertion.
    const source = file('cy.wait(500);', "cy.get('[data-cy=total]').should('contain', '42');");
    assert.equal(hasAssertionAfter(source, 1), true);
    assert.equal(hasAssertionAfter(file('cy.wait(500);', 'cy.screenshot();'), 1), false, 'a screenshot proves nothing');
  });

  it('waits for the element cy.get names', () => {
    assert.equal(thingToWaitFor("cy.get('[data-cy=submit]').click();", 'cypress'), "cy.get('[data-cy=submit]')");
    const source = file('cy.wait(500);', "cy.get('[data-cy=submit]').click();", "cy.get('.result').should('be.visible');");
    const [site] = findFixedWaits(source);
    const candidates = waitFixCandidates(source, site, 'cypress');
    assert.equal(candidates[0].replacement, '');
    assert.equal(candidates[1].replacement, "cy.get('[data-cy=submit]').should('be.visible');");
  });
});
