// Deterministic readers for Playwright error messages. Each returns null (or false)
// when the message does not carry the signal; none of them guess.

const CALL_LOG = /\n\s*Call log:/;

const headOf = (message: string) => message.split(CALL_LOG)[0];
const callLogOf = (message: string) => message.split(CALL_LOG)[1] ?? '';

/** The element the failing call waited for never matched anything on the page. */
export function isElementNotFound(message: string): boolean {
  if (/element\(s\) not found/i.test(message)) return true;
  const callLog = callLogOf(message);
  return /Timeout \d+ms exceeded/.test(headOf(message)) && /waiting for /.test(callLog) && !/resolved to /.test(callLog);
}

const LOCATOR_START = /^(?:locator|getBy[A-Z]\w*|frameLocator|internal:)/;

/** The locator the failing call was waiting for, as Playwright printed it. */
export function extractLocator(message: string): string | null {
  const waited = [...message.matchAll(/waiting for (.+)/g)].map((m) => m[1].trim()).filter((s) => LOCATOR_START.test(s));
  const header = message.match(/^\s*Locator:\s*(.+)$/m)?.[1]?.trim();
  return waited.at(-1) ?? header ?? null;
}

export interface ValueMismatch {
  expected: string;
  received: string;
}

/**
 * How each language's assertion library prints "got the wrong value". Each pattern captures the
 * expected and the actual value; the order of the groups differs, so each names its own.
 */
const MISMATCH_PATTERNS: Array<{ pattern: RegExp; expected: number; received: number }> = [
  // Playwright, Jest, Vitest, node:test: "Expected: 4" / "Received: 3" on separate lines.
  // A runner may print the error type first: "AssertionError: Expected: 4", or node:test's
  // "Error [ERR_TEST_FAILURE]: Expected: 4".
  { pattern: /^(?:[\w.]*Error(?: \[\w+\])?:\s*)?\s*Expected[^:\n]*:\s*(.+)$[\s\S]*?^\s*Received[^:\n]*:\s*(.+)$/m, expected: 1, received: 2 },
  // xUnit (.NET): "Expected: 4" / "Actual: 3".
  { pattern: /^\s*Expected:\s*(.+)$[\s\S]*?^\s*Actual:\s*(.+)$/m, expected: 1, received: 2 },
  // NUnit (.NET): "Expected: 4" / "But was: 3".
  { pattern: /^\s*Expected:\s*(.+)$[\s\S]*?^\s*But was:\s*(.+)$/m, expected: 1, received: 2 },
  // RSpec (Ruby): "expected: 4" / "got: 3".
  { pattern: /^\s*expected:\s*(.+)$[\s\S]*?^\s*got:\s*(.+)$/m, expected: 1, received: 2 },
  // JUnit 4/5, TestNG, Kotlin (Java/JVM): "expected: <4> but was: <3>".
  { pattern: /expected:\s*<([^>\n]*)>\s*but was:\s*<([^>\n]*)>/, expected: 1, received: 2 },
  // Go convention: "got 3, want 4".
  { pattern: /\bgot:?\s*([^,\n]+),\s*want:?\s*(.+)$/m, expected: 2, received: 1 },
  // Rust assert_eq!: "left: 3" / "right: 4" (actual on the left by convention).
  { pattern: /^\s*left:\s*(.+)$[\s\S]*?^\s*right:\s*(.+)$/m, expected: 2, received: 1 },
  // Python unittest: "AssertionError: 3 != 4" (actual first).
  { pattern: /AssertionError:\s*([^\n]+?)\s+!=\s+([^\n]+)$/m, expected: 2, received: 1 },
  // pytest assertion rewriting: "assert 3 == 4" (actual first by convention).
  { pattern: /^\s*(?:E\s+)?assert\s+(.+?)\s+==\s+(.+)$/m, expected: 2, received: 1 },
  // PHPUnit: "Failed asserting that 3 is identical to 4." / "... matches expected 4."
  { pattern: /Failed asserting that (.+?) (?:is identical to|is equal to|matches expected) (.+?)\.?$/m, expected: 2, received: 1 },
  // Chai (Mocha): "expected 3 to equal 4".
  { pattern: /expected (.+?) to (?:deeply )?(?:equal|be|eql) (.+)$/m, expected: 2, received: 1 },
];

/** A comparison that found the value (or element) but not the expected one, in any language. */
export function valueMismatch(message: string): ValueMismatch | null {
  const head = headOf(message);
  for (const { pattern, expected: e, received: r } of MISMATCH_PATTERNS) {
    const m = head.match(pattern);
    if (!m) continue;
    const expected = m[e]?.trim();
    const received = m[r]?.trim();
    if (!expected || !received || /element\(s\) not found/i.test(received)) return null;
    return { expected, received };
  }
  return null;
}

export interface NetworkSignal {
  kind: 'connection' | 'http-5xx' | 'auth';
  /** The text that triggered the signal. */
  match: string;
  confidence: number;
}

const NETWORK_PATTERNS: Array<{ kind: NetworkSignal['kind']; confidence: number; pattern: RegExp }> = [
  {
    kind: 'connection',
    confidence: 0.9,
    pattern:
      /net::ERR_[A-Z_]+|NS_ERROR_[A-Z_]+|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|socket hang up|connection (?:refused|reset|closed)/i,
  },
  // Node's built-in fetch (undici) reports every network-level failure (refused, reset, DNS) as
  // this one line, with the real cause nested where test reporters usually drop it.
  { kind: 'connection', confidence: 0.8, pattern: /TypeError: fetch failed/ },
  { kind: 'http-5xx', confidence: 0.85, pattern: /\b(?:5\d\d\s+)?(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i },
  { kind: 'http-5xx', confidence: 0.85, pattern: /\b(?:status(?:\s*code)?|HTTP(?:\/[\d.]+)?|response code)\b\D{0,12}\b5\d\d\b/i },
  // expect(response.status()).toBe(200) that received a 5xx.
  { kind: 'http-5xx', confidence: 0.8, pattern: /Expected[^:\n]*:\s*"?[23]\d\d"?\s*\n\s*Received[^:\n]*:\s*"?5\d\d\b"?/ },
  { kind: 'auth', confidence: 0.7, pattern: /\b(?:401|403)\s+(?:Unauthorized|Forbidden)\b|\b(?:invalid|expired) (?:auth(?:entication)? )?(?:token|session|credentials)\b/i },
  { kind: 'auth', confidence: 0.7, pattern: /Expected[^:\n]*:\s*"?[23]\d\d"?\s*\n\s*Received[^:\n]*:\s*"?40[13]\b"?/ },
];

/** First network / dependent-service / auth signal in the message, strongest first. */
export function networkSignal(message: string): NetworkSignal | null {
  for (const { kind, confidence, pattern } of NETWORK_PATTERNS) {
    const match = message.match(pattern)?.[0];
    if (match) return { kind, confidence, match: match.replace(/\s+/g, ' ').trim() };
  }
  return null;
}

export interface StrictModeViolation {
  locator: string;
  count: number;
  /** true for an action (click, fill…); false for an expect() assertion. */
  isAction: boolean;
  /** The elements Playwright found, with the locator it suggests for each ("aka …"). */
  elements: Array<{ locator: string; role?: string; name?: string }>;
}

/** A locator that matched several elements; Playwright lists each one with a unique locator. */
export function strictModeViolation(message: string): StrictModeViolation | null {
  const head = headOf(message);
  const m = head.match(/strict mode violation: (.+) resolved to (\d+) elements/);
  if (!m) return null;
  const elements = [...head.matchAll(/^\s*\d+\) .* aka (.+)$/gm)].map(([, locator]) => {
    const role = locator.match(/^getByRole\('([^']+)'/)?.[1];
    const name = locator.match(/name: '((?:[^'\\]|\\.)*)'/)?.[1]?.replaceAll("\\'", "'");
    return { locator: locator.trim(), role, name };
  });
  return { locator: m[1].trim(), count: Number(m[2]), isAction: !/^\s*Error: expect\(/.test(head), elements };
}

/** The accessible name or text a locator looks for, when it names one. */
export function locatorName(locator: string): string | null {
  const m = [...locator.matchAll(/(?:name: |getBy(?:Text|Label|Title|Placeholder|AltText)\()'((?:[^'\\]|\\.)*)'/g)].at(-1);
  return m ? m[1].replaceAll("\\'", "'") : null;
}
