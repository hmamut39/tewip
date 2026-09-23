// What to put in place of a fixed wait, and - more important - when there is nothing safe to put.
//
// Split out of waits.ts after the first measurement of this fix against real commits: 60 commits
// from 47 public repositories in which a developer removed one fixed wait from a test. Two things
// that measurement showed:
//
// 1. Tewip offered a second option in 0 of 43 proposals. The explicit-wait candidate existed but
//    almost never fired, because it only recognised a Playwright action written in one shape. So in
//    practice Tewip could only ever say "delete the wait", and disagreed with the developer in 27
//    cases where they waited for something instead.
// 2. More serious: deleting a fixed wait is only safe when the *next* step waits by itself.
//    `await expect(locator).toBeVisible()` retries until it passes, so the fixed wait before it is
//    pure delay. `const url = page.url()`, `.count()`, `.textContent()` and `if (await x.isEnabled())`
//    read a value once and never retry - and those were common in the real commits. Deleting the
//    wait in front of one of those removes the only thing making the read reliable, and because a
//    race passes by luck, even three passing runs can fail to catch it.
//
// So a bare deletion is now offered only in front of a step that retries on its own. Everywhere
// else Tewip must name something to wait for, or refuse.

/** A step that waits by itself, so a fixed wait in front of it only adds time. */
export function nextStepRetries(line: string, framework: 'playwright' | 'cypress' | 'other'): boolean {
  // A step that is itself a wait needs no framework behind it: `await waitFor(() => ready)` blocks
  // until the condition holds, so a fixed sleep in front of it is pure delay whatever the stack.
  if (SELF_WAITING.test(line)) return true;
  if (framework === 'cypress') {
    // Every cy.* query retries until it resolves, except cy.wait itself.
    return /\bcy\.(?!wait\b)\w+\s*\(/.test(line);
  }
  if (framework !== 'playwright') return false;
  // `await expect(page.getByRole(...)).toBeVisible()` retries; `expect(page.url())` and
  // `expect(await x.count())` read a value once and do not.
  const assertion = /\bexpect\s*\(\s*([^)]*)/.exec(line);
  if (assertion && !/\bawait\b/.test(assertion[1]) && LOCATOR_EXPRESSION.test(assertion[1])) return true;
  // A step that is itself a wait, or a navigation, already blocks until the page is ready: a fixed
  // wait in front of `await this.cancelButton().waitFor({ state: 'visible' })` is pure delay, and
  // that exact line appeared in the real commits.
  if (SELF_WAITING.test(line)) return true;
  // An action on a locator waits for that element to be actionable first.
  return ACTION_ON_LOCATOR.test(line);
}

const SELF_WAITING =
  /\.\s*waitFor(?:Selector|URL|LoadState|Function|Event|Response|Request|Navigation)?\s*\(|\.\s*goto\s*\(|\b(?:waitFor|waitUntil|wait_for|waitForCondition|until)\w*\s*\(/;
const LOCATOR_EXPRESSION = /(?:page|frame|component|[\w$]+)\s*\.\s*(?:getBy\w+|locator|frameLocator)\s*\(|^\s*[\w$]+\s*$/;
const ACTION_ON_LOCATOR =
  /(?:getBy\w+\([^;]*?\)|locator\([^;]*?\))(?:\s*\.\s*\w+\([^;]*?\))*?\s*\.\s*(?:click|fill|press|check|uncheck|selectOption|hover|type|tap|dragTo|setInputFiles|focus)\s*\(/;

/**
 * The thing worth waiting for instead of the guess: whatever the next step acts on or reads.
 * Recognising only `locator.click()` was why the explicit-wait option never appeared in practice;
 * real code just as often assigns the locator first, asserts on it, or reads from it.
 */
export function thingToWaitFor(line: string, framework: 'playwright' | 'cypress' | 'other'): string | null {
  if (framework === 'cypress') {
    const m = /\bcy\.get\s*\(\s*([^)]+?)\s*\)/.exec(line);
    return m ? `cy.get(${m[1]})` : null;
  }
  const chain = /((?:page|frame|component|[\w$]+)\s*\.\s*(?:getBy\w+|locator|frameLocator)\s*\([^;]*?\)(?:\s*\.\s*(?:first|last|nth|filter|getBy\w+|locator)\s*\([^;]*?\))*)/.exec(line);
  if (!chain) return null;
  const expression = chain[1].trim();
  // `await page.locator('x').count()` and `const n = page.locator('x')` both point at the same
  // element; the expression itself is what to wait for either way.
  return expression.startsWith('.') ? `page${expression}` : expression;
}
