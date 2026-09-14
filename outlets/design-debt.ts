// Test-design debt visible in a failure: fixed waits and brittle selectors. Read from the
// failing locator and the code around the failing line only (not the whole spec).

export interface DesignDebt {
  kind: 'hard-wait' | 'brittle-selector';
  detail: string;
}

const HARD_WAIT = /waitForTimeout\(\s*\d+|new Promise\([^)]*setTimeout|\bsleep\(\s*\d+/;

const BRITTLE: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /nth-child|nth-of-type|\.nth\(|:nth-match|\.first\(\)|\.last\(\)/, why: 'position-based' },
  { pattern: /xpath=|^locator\(\s*['"]\/\//, why: 'XPath' },
  { pattern: /^locator\(\s*['"][^'"]*\s>\s/, why: 'deep CSS chain' },
  { pattern: /^locator\(\s*['"][^'"#]*\.[a-zA-Z_-][\w-]*/, why: 'CSS class' },
];

export function designDebt(locator: string | null, code: string[] | null): DesignDebt[] {
  const debt: DesignDebt[] = [];
  const waitLine = code?.find((line) => HARD_WAIT.test(line.split('|').slice(1).join('|')));
  if (waitLine) debt.push({ kind: 'hard-wait', detail: waitLine.split('|').slice(1).join('|').trim() });
  // Role / label / test-id locators are the robust kind; only raw CSS/XPath can be brittle.
  if (locator && !/^getBy/.test(locator)) {
    const hit = BRITTLE.find((b) => b.pattern.test(locator));
    if (hit) debt.push({ kind: 'brittle-selector', detail: `${hit.why}: ${locator}` });
  }
  return debt;
}
