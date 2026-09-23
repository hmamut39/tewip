// Phase 8: replacing a fixed wait with a condition. `await page.waitForTimeout(3000)` is the most
// common cause of a flaky browser test: it is a guess about how long something takes, so it fails on
// a slow day and wastes three seconds on every good one. The fix is to wait for the thing itself.
//
// What makes this different from a locator fix, and why it is safe: a wrong locator fails every
// time, so one passing run proves the fix. A race passes by luck, so one passing run proves nothing.
// A wait fix is therefore only accepted after several passes in a row, and the whole change is
// deleting or replacing a line whose only job was to wait.
// What may follow the wait on its own line and still leave it a pure wait: a semicolon, and a
// comment. Real code nearly always carries one - `cy.wait(500); // eslint-disable-line` is written
// precisely *because* the line is a fixed wait, and `waitForTimeout(300); // allow debounce` says
// what the guess was for. Requiring the line to end after the call made Tewip refuse 15 of 60 real
// fixed-wait removals harvested from public repositories, which is how this was found.
const TRAILING = String.raw`\s*;?\s*(?://.*)?$`;
const TRAILING_PY = String.raw`\s*(?:#.*)?$`;
/** Digits, allowing JavaScript's numeric separators: `3_000` is as common as `3000`. */
const MS = String.raw`[\d_]+`;

import { nextStepRetries, thingToWaitFor } from './wait-candidates.ts';

const FIXED_WAIT = [
  // Playwright and Puppeteer
  new RegExp(String.raw`^(?<indent>\s*)(?:await\s+)?[\w.]*page\.waitForTimeout\(\s*(?<ms>${MS})\s*\)${TRAILING}`),
  // Cypress
  new RegExp(String.raw`^(?<indent>\s*)cy\.wait\(\s*(?<ms>${MS})\s*\)${TRAILING}`),
  // WebdriverIO and anything with a sleep helper
  new RegExp(String.raw`^(?<indent>\s*)(?:await\s+)?(?:browser\.pause|sleep|delay)\(\s*(?<ms>${MS})\s*\)${TRAILING}`),
  // The hand-rolled sleep, which is what people write when no helper exists:
  // `await new Promise(resolve => setTimeout(resolve, 500))`.
  new RegExp(String.raw`^(?<indent>\s*)(?:await\s+)?new\s+Promise\(\s*\(?\s*(?<arg>\w+)\s*\)?\s*=>\s*setTimeout\(\s*\k<arg>\s*,\s*(?<ms>${MS})\s*\)\s*\)${TRAILING}`),
  // Java and Kotlin
  new RegExp(String.raw`^(?<indent>\s*)Thread\.sleep\(\s*(?<ms>${MS})\s*\)${TRAILING}`),
  // Python
  new RegExp(String.raw`^(?<indent>\s*)time\.sleep\(\s*(?<seconds>[\d._]+)\s*\)${TRAILING_PY}`),
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
      const digits = (text: string) => Number(text.replace(/_/g, ''));
      const ms = m.groups.seconds ? Math.round(digits(m.groups.seconds) * 1000) : digits(m.groups.ms);
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

export interface WaitFixCandidate {
  /** The replacement for the whole line; an empty string removes it. */
  replacement: string;
  /** Why this is the right thing to do, for the pull request. */
  why: string;
}

/**
 * What to put in place of the fixed wait, best first - and nothing at all when nothing is safe.
 *
 * Deleting it comes first only where the next step waits by itself: Playwright and Cypress wait for
 * an element before acting on it, and a web-first assertion retries until it passes, so a fixed wait
 * in front of one of those is pure delay. In front of a step that reads a value once -
 * `page.url()`, `.count()`, `if (await x.isEnabled())` - the fixed wait may be the only thing making
 * the read reliable, so deletion is not offered there at all and Tewip must name something to wait
 * for or refuse. Measured against 60 real fixed-wait removals in 47 public repositories.
 */
export function waitFixCandidates(source: string, site: WaitSite, framework: 'playwright' | 'cypress' | 'other'): WaitFixCandidate[] {
  const lines = source.split('\n');
  const next = lines.slice(site.line, site.line + 3).find((l) => l.trim() && !l.trim().startsWith('//'));
  if (!next) return [];
  const candidates: WaitFixCandidate[] = [];

  if (nextStepRetries(next, framework)) {
    candidates.push({
      replacement: '',
      why: `${framework === 'cypress' ? 'Cypress' : 'Playwright'} already waits for the next step to be ready, so the fixed ${site.ms} ms wait only added time.`,
    });
  }

  const thing = thingToWaitFor(next, framework);
  if (thing) {
    candidates.push(
      framework === 'cypress'
        ? { replacement: `${site.indent}${thing}.should('be.visible');`, why: `Waits for ${thing} to be there instead of guessing ${site.ms} ms.` }
        : { replacement: `${site.indent}await expect(${thing}).toBeVisible();`, why: `Waits for ${thing} to be there instead of guessing ${site.ms} ms.` },
    );
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
