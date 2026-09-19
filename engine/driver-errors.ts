// Deterministic readers for the error wording of browser tools other than Playwright: Selenium
// (Java, Python, JavaScript, C#), WebdriverIO and Cypress. Each tool says "element not found",
// "something else took the click" and "the element went stale" in its own words; these map them
// onto the same signals the rules read from Playwright. None of them guess: no match, no signal.
// The patterns were checked against 264 real messages pasted into public GitHub issues and pull
// requests (old and new driver versions, every Selenium language binding).

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
];

/** A no-such-element exception that printed no locator (Selenium's Python bindings often do). */
const NOT_FOUND_BARE = /\bNoSuchElement(?:Exception|Error)\b|\bno such element\b/i;

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
