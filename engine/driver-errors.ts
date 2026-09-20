// Deterministic readers for the error wording of browser and component-test tools other than
// Playwright: Selenium (Java, Python, JavaScript, C#), WebdriverIO, Cypress, Testing Library (React,
// Vue, Angular, Svelte), Vue Test Utils, jest-dom, and the mobile tools (Appium, Espresso, Detox,
// Maestro, XCUITest, Flutter). Each tool says "element not found",
// "something else took the click" and "the element went stale" in its own words; these map them
// onto the same signals the rules read from Playwright. None of them guess: no match, no signal.
// The patterns were checked against real messages pasted into public GitHub issues and pull
// requests: 264 from browser tools (old and new driver versions, every Selenium binding) and 260
// from component tests (Testing Library, Vue Test Utils, jest-dom, Jasmine).

/** The element was looked for and never found, as each tool reports it, with the locator used. */
const NOT_FOUND: Array<{ pattern: RegExp; locator: (m: RegExpMatchArray) => string }> = [
  // Selenium, Chrome and Edge drivers: Unable to locate element: {"method":"css selector","selector":"#save"}
  // The selector is printed without escaping its own quotes, and a paste may cut it off.
  { pattern: /Unable to locate element:\s*\{"method":\s*"([^"]+)"(?:,\s*"selector":\s*"(.*?)(?:"\}|$))?/m, locator: (m) => (m[2] !== undefined ? `${m[1]}=${m[2].replaceAll(`\\"`, `"`)}` : m[1]) },
  // Atata (C#): Unable to locate element:\n- By: XPath ".//td[6]"
  { pattern: /Unable to locate element:\s*- By: (\w+ ".*?")$/m, locator: (m) => m[1] },
  // Selenium, Firefox driver: Unable to locate element: #save (the selector may start on the next line)
  { pattern: /Unable to locate element:[ \t]*\n?[ \t]*([^\s;{'"][^\n;]*)/, locator: (m) => m[1].trim() },
  // Selenium explicit waits (Java), in their many shapes: waiting for visibility of element located by
  // By.id: save (tried for...), waiting for element to be clickable: By.id: save, waiting for By.css: x to be displayed.
  // Waits for an element to disappear or go stale are not "not found" and are left out.
  { pattern: /Expected condition failed: waiting for (?![^\n]*(?:invisibility|stale|to be invisible))[\s\S]{0,80}?(By\.\w+:\s*[\s\S]+?|css=[^\n(]+?)(?=\s+to be \w|\s*\(tried for|\s*$)/m, locator: (m) => m[1].replace(/\s+/g, ' ').trim() },
  // Selenium JavaScript waits: Waiting for element to be located By(css selector, #save)\nWait timed out after 10043ms
  { pattern: /Waiting for element to be located (?:By\(([^,]+), (.+?)\)|(by function\(\))|(\S+))\s*\n?\s*Wait timed out/, locator: (m) => (m[1] ? `${m[1]}=${m[2]}` : m[3] ?? m[4]) },
  // Selenium C# waits: Element with By By.XPath: //x not found
  { pattern: /Element with By (By\.\w+: .+?) not found/, locator: (m) => m[1] },
  // WebdriverIO: element ("#save") still not displayed after 5000ms; the selector may hold quotes, or none
  { pattern: /element \((?:"(.*?)"|([^)"\s][^)]*))\)\s*still not (?:displayed|existing|clickable|enabled) after \d+ ?ms/, locator: (m) => m[1] ?? m[2] },
  // WebdriverIO: Can't call click on element with selector "#save" because element wasn't found
  { pattern: /on element with selector "(.*?)" because element wasn't found/, locator: (m) => m[1] },
  // Cypress: Expected to find element: `#save`, but never found it. Old versions quote with ' or not at all;
  // cy.contains adds "containing text: 'x'".
  { pattern: /Expected to find element:\s*[`']?([^`'\n]+?)[`']?(?:\s+containing text:\s*'((?:[^'\\]|\\.)*)')?,?\s+but never found it/, locator: (m) => (m[2] !== undefined ? `cy.contains('${m[1]}', '${m[2]}')` : m[1]) },
  // Cypress: Expected to find content: 'Save' [within the element: <h1>] but never did.
  { pattern: /Expected to find content:\s*'((?:[^'\\]|\\.)*)'[\s\S]{0,300}?but never did/, locator: (m) => `cy.contains('${m[1]}')` },
  // Testing Library (React, Vue, Angular, Svelte component tests), written as the same getBy... query
  // Playwright uses, so the drift rules can read its name: Unable to find an accessible element with
  // the role "button" and name "Save".
  { pattern: /Unable to find an accessible element with the role "([^"]+)"(?: and name (?:"([^"\n]*)"|`([^`\n]*)`))?/, locator: (m) => (m[2] ?? m[3]) !== undefined ? `getByRole('${m[1]}', { name: ${arg(m[2] ?? m[3])} })` : `getByRole('${m[1]}')` },
  // Older Testing Library: Unable to find role="button" and name "Save"
  { pattern: /Unable to find role="([^"]+)"(?: and name (?:"([^"\n]*)"|`([^`\n]*)`))?/, locator: (m) => (m[2] ?? m[3]) !== undefined ? `getByRole('${m[1]}', { name: ${arg(m[2] ?? m[3])} })` : `getByRole('${m[1]}')` },
  { pattern: /Unable to find an element by: \[data-testid="([^"]+)"\]/, locator: (m) => `getByTestId('${m[1]}')` },
  { pattern: /Unable to find a label with the text of: (.+?)\.?$/m, locator: (m) => `getByLabel(${arg(m[1])})` },
  { pattern: /Unable to find an element with the (placeholder text|alt text|title|display value)(?: of)?: (.+?)\.?$/m, locator: (m) => `getBy${{ 'placeholder text': 'Placeholder', 'alt text': 'AltText', title: 'Title', 'display value': 'DisplayValue' }[m[1]]}(${arg(m[2])})` },
  { pattern: /Unable to find an element with the text: (.+?)\.?(?: This could be| \.\.\.|$)/m, locator: (m) => `getByText(${arg(m[1])})` },
  // Espresso (Android): NoMatchingViewException: No views in hierarchy found matching: (view.getId() is <2131296257/app:id/save>...)
  { pattern: /No views in hierarchy found matching:[ \t]*([^\n]+)/, locator: (m) => m[1].trim() },
  // Detox: No elements found for "MATCHER(identifier == "save-button")"
  // The matcher itself holds quotes, so this takes everything up to the last one on the line.
  { pattern: /No elements found for[ \t]*[“"']([^\n]+)[”"']/, locator: (m) => m[1].trim() },
  // Maestro: Element not found: Text matching regex: Save
  { pattern: /Element not found:[ \t]*([^\n]+)/, locator: (m) => m[1].trim() },
  // XCUITest: No matches found for Element at index 25
  { pattern: /No matches found for[ \t]*([^\n]+)/, locator: (m) => m[1].trim() },
  // Flutter: Actual: Found 0 widgets with widget matching predicate: [] // identifier('L1 O')
  { pattern: /Found 0 widgets with[ \t]*([^\n]+)/, locator: (m) => m[1].trim() },
  // Vue Test Utils 1: [vue-test-utils]: find did not return button.save, cannot call trigger() on empty Wrapper
  { pattern: /find did not return (.+?), cannot call/, locator: (m) => m[1] },
];

/** A Testing Library argument: a /regex/ stays as written, text is quoted. */
const arg = (s: string) => (/^\/.*\/[a-z]*$/.test(s.trim()) ? s.trim() : `'${s.trim().replaceAll("'", "\\'")}'`);

/**
 * Not found, with no locator printed: Selenium's Python bindings, Vue Test Utils 2 ("Cannot call text
 * on an empty DOMWrapper") and jest-dom given a query that found nothing ("received value must be an
 * HTMLElement", "element could not be found in the document").
 */
const NOT_FOUND_BARE = /\bNoSuchElement(?:Exception|Error)\b|\bno such element\b|Cannot call \w+ on an empty (?:DOM)?Wrapper|received value must be an HTMLElement or an SVGElement|element could not be found in the document|An element could not be located on the page using the given search parameters/i;

export function driverElementNotFound(message: string): boolean {
  return NOT_FOUND_BARE.test(message) || NOT_FOUND.some(({ pattern }) => pattern.test(message));
}

/** The locator a Selenium, WebdriverIO or Cypress lookup used, as the error printed it. */
export function driverLocator(message: string): string | null {
  for (const { pattern, locator } of NOT_FOUND) {
    const m = message.match(pattern);
    if (m) return locator(m);
  }
  return null;
}

/** What received the click instead, when a tool reports the click was blocked. */
export function driverClickIntercepted(message: string): string | null {
  // Chrome: ... is not clickable at point (10, 20). Other element would receive the click: <div class="overlay">
  const chrome = message.match(/Other element would receive the click:\s*`?(<[^>]+>)?/);
  if (chrome) return chrome[1] ?? 'another element';
  // Firefox: Element <li> is not clickable at point (1168,92) because another element <a href="/x"> obscures it
  const firefox = message.match(/is not clickable at point \([^)]*\) because another element (<[^>]+>)/);
  if (firefox) return firefox[1];
  // Chrome, when it cannot name the element on top: element click intercepted: Element is not clickable at point (241, 600)
  if (/element click intercepted|ElementClickIntercepted(?:Exception|Error)/.test(message)) return 'another element';
  // Cypress: cy.click() failed because this element: <button> is being covered by another element: <div class="modal">
  const cypress = message.match(/(?:is|it's|its) being covered by another element:?\s*`?(<[^>]+>)?/);
  return cypress ? cypress[1] ?? 'another element' : null;
}

/** The element was found, then the page replaced it before the test used it. */
export function driverStaleElement(message: string): string | null {
  if (/waiting for [^\n]*to become stale|staleness of/i.test(message)) return null;
  const m = message.match(
    /\bStaleElementReference(?:Exception|Error)\b|stale element (?:reference|not found)|element is not attached to the page document|element reference (?:of .{0,200}? )?is stale|with the reference \S+ is stale|is no longer (?:attached|connected) to the DOM|failed because the page updated while this command was executing|failed because (?:this|the) element is detached from the DOM/i,
  );
  return m ? m[0] : null;
}
