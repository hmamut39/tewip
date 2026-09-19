// Selenium, WebdriverIO and Cypress say "not found", "click blocked" and "stale element" in their
// own words. Each message below is the tool's real wording; the rules must read it like Playwright's.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TriageRecord } from '../../reporters/types.ts';
import { driverClickIntercepted, driverStaleElement } from '../driver-errors.ts';
import { diagnose } from '../engine.ts';
import { extractLocator, isElementNotFound, locatorName } from '../error-parse.ts';
import { HistoryIndex } from '../history.ts';

function run(errorMessage: string) {
  const record: TriageRecord = {
    schemaVersion: 1,
    testId: 'LoginTest > signs in',
    file: 'LoginTest.java',
    status: 'failed',
    errorMessage,
    errorStack: errorMessage,
    duration: 100,
    retry: 0,
    attachments: [],
    runId: 'r1',
    gitSha: '',
    timestamp: '2026-01-01T00:00:00Z',
  };
  const index = new HistoryIndex([record], [{ schemaVersion: 1, runId: 'r1', gitSha: '', startedAt: record.timestamp, finishedAt: record.timestamp, status: 'failed', attempts: { [record.testId]: 1 } }]);
  return diagnose({ record, history: index.historyAsOf(record.testId, 'r1'), run: index.runContext('r1'), loadSnapshot: () => null });
}

const NOT_FOUND: Array<[string, string, string | null]> = [
  [
    'Selenium Java, Chrome',
    'org.openqa.selenium.NoSuchElementException: no such element: Unable to locate element: {"method":"css selector","selector":"#login-button"}\n  (Session info: chrome=128.0.6613.84)\nFor documentation on this error, please visit: https://www.selenium.dev/documentation/webdriver/troubleshooting/errors#no-such-element-exception',
    'css selector=#login-button',
  ],
  [
    'Selenium Python, Chrome',
    'selenium.common.exceptions.NoSuchElementException: Message: no such element: Unable to locate element: {"method":"xpath","selector":"//button[text()=\\"Save\\"]"}',
    'xpath=//button[text()="Save"]',
  ],
  ['Selenium, Firefox', 'selenium.common.exceptions.NoSuchElementException: Message: Unable to locate element: #login-button; For documentation on this error, please visit: https://www.selenium.dev', '#login-button'],
  ['Selenium JavaScript', 'NoSuchElementError: no such element: Unable to locate element: {"method":"css selector","selector":"[data-test=\\"save\\"]"}', 'css selector=[data-test="save"]'],
  [
    'Selenium Java explicit wait',
    'org.openqa.selenium.TimeoutException: Expected condition failed: waiting for visibility of element located by By.id: username (tried for 10 second(s) with 500 milliseconds interval)',
    'By.id: username',
  ],
  ['Selenium, no locator printed', 'selenium.common.exceptions.NoSuchElementException: Message: ', null],
  ['WebdriverIO wait', 'Error: element ("#login-button") still not displayed after 10000ms', '#login-button'],
  ['WebdriverIO action', 'Error: Can\'t call click on element with selector "#login-button" because element wasn\'t found', '#login-button'],
  ['Cypress get', 'AssertionError: Timed out retrying after 4000ms: Expected to find element: `[data-cy=submit]`, but never found it.', '[data-cy=submit]'],
  ['Cypress contains', "AssertionError: Timed out retrying after 4000ms: Expected to find content: 'Sign in' but never did.", "cy.contains('Sign in')"],
];

describe('element not found, in every tool', () => {
  for (const [tool, message, locator] of NOT_FOUND) {
    it(`reads ${tool}`, () => {
      assert.equal(isElementNotFound(message), true);
      assert.equal(extractLocator(message), locator);
    });
  }

  it('reads the text a Cypress contains() looked for, so drift can search the page for it', () => {
    assert.equal(locatorName("cy.contains('Sign in')"), 'Sign in');
  });

  it('is not fooled by a wrong value or a Cypress "not to find"', () => {
    assert.equal(isElementNotFound("AssertionError: expected 'Hello' to equal 'Hi'"), false);
    assert.equal(isElementNotFound('Timed out retrying after 4000ms: Expected not to find element: `.spinner`, but it was continuously found.'), false);
  });

  it('never calls a renamed element without a page to look at: it says what was missing and declines', () => {
    const d = run(NOT_FOUND[0][1]);
    assert.notEqual(d.category, 'LOCATOR_DRIFT');
    assert.ok(d.evidence.some((e) => /#login-button/.test(e.message)));
  });
});

describe('a click something else received', () => {
  const SELENIUM =
    'org.openqa.selenium.ElementClickInterceptedException: element click intercepted: Element <button id="save">...</button> is not clickable at point (412, 318). Other element would receive the click: <div class="modal-backdrop fade show"></div>';
  const CYPRESS = 'CypressError: Timed out retrying after 4050ms: `cy.click()` failed because this element:\n\n`<button id="save">Save</button>`\n\nis being covered by another element:\n\n`<div class="toast">Saved</div>`';

  it('names the element on top, from Selenium and Cypress', () => {
    assert.equal(driverClickIntercepted(SELENIUM), '<div class="modal-backdrop fade show">');
    assert.equal(driverClickIntercepted(CYPRESS), '<div class="toast">');
  });

  for (const [tool, message] of [['Selenium', SELENIUM], ['Cypress', CYPRESS]]) {
    it(`calls it TIMING from ${tool}, below the merge gate's trust line until measured`, () => {
      const d = run(message);
      assert.equal(d.category, 'TIMING');
      assert.equal(d.ruleId, 'timing-intercepted');
      assert.ok(d.confidence < 0.7);
    });
  }
});

describe('a stale element', () => {
  const STALE = [
    'org.openqa.selenium.StaleElementReferenceException: stale element reference: stale element not found in the current frame',
    'selenium.common.exceptions.StaleElementReferenceException: Message: stale element reference: element is not attached to the page document',
    'StaleElementReferenceError: The element with the reference 5f2e is stale; either its node document is not the active document, or it is no longer connected to the DOM',
    'CypressError: `cy.click()` failed because the page updated while this command was executing. Cypress tried to locate elements based on this query',
  ];
  for (const message of STALE) {
    it(`calls it TIMING: ${message.slice(0, 50)}`, () => {
      assert.ok(driverStaleElement(message));
      const d = run(message);
      assert.equal(d.category, 'TIMING');
      assert.equal(d.ruleId, 'timing-stale-element');
      assert.ok(d.confidence < 0.7);
    });
  }

  it('does not fire on an ordinary assertion that mentions staleness', () => {
    assert.equal(driverStaleElement("expected 'stale' to equal 'fresh'"), null);
  });
});
