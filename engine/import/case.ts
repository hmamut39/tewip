// The shape every report format is read into.
//
// A JUnit XML, a .trx, an NUnit file, a JMeter log and a k6 summary all say the same few things in
// different words: which test, in which file, how long it took, and what happened on each attempt.
// Keeping that shape here lets each reader live in its own file without importing another reader.
export interface Attempt {
  failed: boolean;
  message: string;
  stack: string;
}

export interface Case {
  testId: string;
  file: string;
  duration: number;
  attempts: Attempt[];
}

/** A passing attempt: the same object every time, since it carries nothing.
 */
export const PASSED: Attempt = { failed: false, message: '', stack: '' };

/** One failed attempt, read out of whatever the runner wrote. */
export function failure(rawMessage: string, rawDetail: string): Attempt {
  // Terminal colour codes: XML cannot hold the escape character, so runners often write what is left
  // of them ("[2mexpect([22m"); both forms are noise to the rules.
  const plain = (s: string) => s.replace(/\u001b?\[(?:\d{1,3};)*\d{1,3}m/g, '');
  const message = plain(rawMessage);
  const detail = plain(rawDetail);
  const head = message.trim() || detail.split('\n').find((l) => l.trim() !== '') || 'failed';
  const stack = detail.trim();
  // The full detail goes into the message too: outside Playwright the useful part (the assertion,
  // the exception) is usually in the detail, and the rules read the message.
  return { failed: true, message: stack && !stack.includes(head) ? `${head}\n${stack}` : stack || head, stack };
}
