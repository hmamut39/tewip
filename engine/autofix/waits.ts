// Phase 8: replacing a fixed wait with a condition. `await page.waitForTimeout(3000)` is the most
// common cause of a flaky browser test: it is a guess about how long something takes, so it fails on
// a slow day and wastes three seconds on every good one. The fix is to wait for the thing itself.
//
// What makes this different from a locator fix, and why it is safe: a wrong locator fails every
// time, so one passing run proves the fix. A race passes by luck, so one passing run proves nothing.
// A wait fix is therefore only accepted after several passes in a row, and the whole change is
// deleting or replacing a line whose only job was to wait.
const FIXED_WAIT = [
  // Playwright and Puppeteer
  /^(?<indent>\s*)(?:await\s+)?[\w.]*page\.waitForTimeout\(\s*(?<ms>\d+)\s*\)\s*;?\s*$/,
  // Cypress
  /^(?<indent>\s*)cy\.wait\(\s*(?<ms>\d+)\s*\)\s*;?\s*$/,
  // WebdriverIO and anything with a sleep helper
  /^(?<indent>\s*)(?:await\s+)?(?:browser\.pause|sleep|delay)\(\s*(?<ms>\d+)\s*\)\s*;?\s*$/,
  // Java and Kotlin
  /^(?<indent>\s*)Thread\.sleep\(\s*(?<ms>\d+)\s*\)\s*;?\s*$/,
  // Python
  /^(?<indent>\s*)time\.sleep\(\s*(?<seconds>[\d.]+)\s*\)\s*$/,
] as const;

export interface WaitSite {
  /** 1-based line number of the fixed wait. */
  line: number;
  /** The line as written, trimmed. */
  text: string;
  /** How long it waits, in milliseconds. */
  ms: number;
  indent: string;
}

/** Every fixed wait in the file, in order. */
export function findFixedWaits(source: string): WaitSite[] {
  const out: WaitSite[] = [];
  for (const [i, line] of source.split('\n').entries()) {
    for (const pattern of FIXED_WAIT) {
      const m = line.match(pattern);
      if (!m?.groups) continue;
      const ms = m.groups.seconds ? Math.round(Number(m.groups.seconds) * 1000) : Number(m.groups.ms);
      out.push({ line: i + 1, text: line.trim(), ms, indent: m.groups.indent ?? '' });
      break;
    }
  }
  return out;
}

/** The wait nearest the failing line, since that is the one the failure waited on. */
export function waitNearest(sites: WaitSite[], failing: number | null): WaitSite | undefined {
  if (sites.length <= 1 || failing === null) return sites[0];
  return [...sites].sort((a, b) => Math.abs(a.line - failing) - Math.abs(b.line - failing))[0];
}

/** The Playwright locator a line acts on, when it has one: the thing worth waiting for instead. */
function locatorIn(line: string): string | null {
  const m = line.match(/((?:page|frame|component)?\.?(?:getBy\w+\([^;]*?\)|locator\([^;]*?\))(?:\.\w+\([^;]*?\))*?)\.(?:click|fill|press|check|selectOption|hover|type|textContent|innerText|isVisible)\(/);
  return m ? m[1].replace(/^\./, 'page.') : null;
}

export interface WaitFixCandidate {
  /** The replacement for the whole line; an empty string removes it. */
  replacement: string;
  /** Why this is the right thing to do, for the pull request. */
  why: string;
}

/**
 * What to put in place of the fixed wait, best first.
 *
 * Removing it is first on purpose: Playwright and Cypress already wait for an element to be
 * actionable before clicking or asserting, so a fixed wait in front of such a step adds nothing but
 * time, and deleting it is the smallest possible change. Where the next line does act on an element,
 * waiting for that element is offered too, for suites whose style is an explicit wait.
 */
export function waitFixCandidates(source: string, site: WaitSite, framework: 'playwright' | 'cypress' | 'other'): WaitFixCandidate[] {
  const lines = source.split('\n');
  const next = lines.slice(site.line, site.line + 3).find((l) => l.trim() && !l.trim().startsWith('//'));
  const autoWaits = framework === 'playwright' || framework === 'cypress';
  const candidates: WaitFixCandidate[] = [];
  if (autoWaits && next) {
    candidates.push({
      replacement: '',
      why: `${framework === 'playwright' ? 'Playwright' : 'Cypress'} already waits for the element in the next step to be ready, so the fixed ${site.ms} ms wait only added time.`,
    });
  }
  const locator = next ? locatorIn(next) : null;
  if (locator) {
    candidates.push({
      replacement: `${site.indent}await expect(${locator}).toBeVisible();`,
      why: `Waits for ${locator} to be there instead of guessing ${site.ms} ms.`,
    });
  }
  return candidates;
}

/** The file with this line replaced, or removed when the replacement is empty. */
export function applyWaitFix(source: string, site: WaitSite, replacement: string): string {
  const lines = source.split('\n');
  if (replacement === '') lines.splice(site.line - 1, 1);
  else lines[site.line - 1] = replacement;
  return lines.join('\n');
}
