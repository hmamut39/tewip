// Deterministic readers for the error wording of browser tools other than Playwright: Selenium
// (Java, Python, JavaScript, C#), WebdriverIO and Cypress. Each tool says "element not found",
// "something else took the click" and "the element went stale" in its own words; these map them
// onto the same signals the rules read from Playwright. None of them guess: no match, no signal.

/** The element was looked for and never found, as each tool reports it, with the locator used. */
const NOT_FOUND: Array<{ pattern: RegExp; locator: (m: RegExpMatchArray) => string }> = [
  // Selenium, Chrome and Edge drivers: Unable to locate element: {"method":"css selector","selector":"#save"}
  { pattern: /Unable to locate element: \{"method":\s*"([^"]+)",\s*"selector":\s*"((?:[^"\\]|\\.)*)"\}/, locator: (m) => `${m[1]}=${m[2].replaceAll('\\"', '"')}` },
  // Selenium, Firefox driver: Unable to locate element: #save
  { pattern: /Unable to locate element: ([^\n;{][^\n;]*)/, locator: (m) => m[1].trim() },
  // Selenium explicit waits (Java): waiting for visibility of element located by By.id: save (tried for 10 second(s) ...
  { pattern: /waiting for [^\n]*?element[^\n]*? located by:? (By\.\w+: .+?)(?: \(tried for|$)/m, locator: (m) => m[1].trim() },
  // WebdriverIO: element ("#save") still not displayed after 5000ms
  { pattern: /element \("((?:[^"\\]|\\.)*)"\) still not (?:displayed|existing|clickable|enabled)/, locator: (m) => m[1] },
  // WebdriverIO: Can't call click on element with selector "#save" because element wasn't found
  { pattern: /on element with selector "((?:[^"\\]|\\.)*)" because element wasn't found/, locator: (m) => m[1] },
  // Cypress: Expected to find element: `#save`, but never found it.
  { pattern: /Expected to find element: `([^`]+)`, but never found it/, locator: (m) => m[1] },
  // Cypress: Expected to find content: 'Save' but never did.
  { pattern: /Expected to find content: '((?:[^'\\]|\\.)*)'(?: within the (?:element|selector): [^\n]*?)? but never did/, locator: (m) => `cy.contains('${m[1]}')` },
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

/** The element that received the click instead, when a tool reports the click was blocked. */
export function driverClickIntercepted(message: string): string | null {
  // Selenium: element click intercepted: Element <button> is not clickable at point (10, 20). Other element would receive the click: <div class="overlay">
  const selenium = message.match(/Other element would receive the click: (<[^>]+>)/);
  if (selenium) return selenium[1];
  // Cypress: cy.click() failed because this element: <button> is being covered by another element: <div class="modal">
  const cypress = message.match(/is being covered by another element:\s*`?(<[^>]+>)/);
  return cypress ? cypress[1] : null;
}

/** The element was found, then the page replaced it before the test used it. */
export function driverStaleElement(message: string): string | null {
  const m = message.match(
    /\bStaleElementReference(?:Exception|Error)\b|stale element (?:reference|not found)|element is not attached to the page document|is no longer attached to the DOM|failed because the page updated while this command was executing|failed because (?:this|the) element is detached from the DOM/i,
  );
  return m ? m[0] : null;
}
