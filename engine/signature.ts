// Error-text normalisation shared by the history table and the rule engine.

/**
 * Error identity used for "same error every time?". Playwright appends a call log whose
 * details (e.g. "9 × locator resolved to ...") change between identical failures, so
 * only the text before "Call log:" is compared.
 */
export function errorSignature(message: string): string {
  return message.split(/\n\s*Call log:/)[0].replace(/\s+/g, ' ').trim();
}

/**
 * Coarser identity used to spot one cause hitting many tests: numbers, URL paths and
 * long ids are blanked, so "ECONNREFUSED at http://host/cart" and ".../checkout" compare
 * equal. Quoted strings are kept, so unrelated assertion failures stay apart.
 */
export function errorShape(message: string): string {
  return errorSignature(message)
    .replace(/\b(https?:\/\/[^/\s'"]+)[^\s'"]*/g, '$1')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(?:\.\d+)?/g, '<n>');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
