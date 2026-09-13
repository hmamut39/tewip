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

/** An expect() comparison that found the element (or value) but not the expected value. */
export function valueMismatch(message: string): ValueMismatch | null {
  const head = headOf(message);
  const expected = head.match(/^\s*Expected[^:\n]*:\s*(.+)$/m)?.[1]?.trim();
  const received = head.match(/^\s*Received[^:\n]*:\s*(.+)$/m)?.[1]?.trim();
  if (!expected || !received || /element\(s\) not found/i.test(received)) return null;
  return { expected, received };
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
