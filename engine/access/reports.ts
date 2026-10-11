// Phase 29: reading a real browser run, so the criteria Phase 28 says it cannot reach stop being
// unreachable.
//
// `tewip access` reads markup and is honest that contrast, focus order and anything else needing a
// rendered page is outside it. The answer is not for Tewip to ship a browser. It is to read the run
// a team already produces - axe, in a Playwright, Cypress or jest-axe suite - and do to its output
// what Phase 9 does to a security scanner's: decide which findings matter, and say why.
//
// Why that is worth doing, measured on axe 4.14 over nine real pages (bootstrap's own component
// pages and excalidraw's index): 122 findings, of which **51 carry no WCAG criterion at all**. Forty
// are `region` ("all content should be contained by landmarks") and nine are `landmark-one-main`.
// Both are axe's own `best-practice` rules, not failures of any standard, and they outnumber every
// real barrier on the page. A team that is handed all 122 as equals stops reading them, which is the
// reported reason accessibility tooling gets switched off.
//
// So the tags decide, not the impact:
//   a wcag* tag  -> a numbered criterion a regulator can cite, and a barrier;
//   best-practice only -> advice, reported apart and never failing a build;
//   `incomplete` -> axe could not determine it, which is exactly Tewip's "ask a person".
import { readFileSync } from 'node:fs';
import type { Severity } from './wcag.ts';

export interface BrowserFinding {
  /** The tool's own rule id: `color-contrast`, `label`. */
  rule: string;
  tool: 'axe';
  /** `barrier` for a WCAG failure, `ask-a-person` for what the tool could not determine,
   *  `advice` for a rule that is somebody's good idea rather than a standard. */
  confidence: 'barrier' | 'ask-a-person' | 'advice';
  /** `1.4.3`, or null for a best-practice rule that maps to no criterion. */
  criterion: string | null;
  level: 'A' | 'AA' | 'AAA' | null;
  /** `9.1.4.3` - the clause in EN 301 549, which is what the European Accessibility Act cites. */
  en301549: string | null;
  severity: Severity;
  /** The element as the browser rendered it. */
  html: string;
  selector: string;
  /** Which page this was found on. */
  page: string;
  why: string;
  next: string;
}

/** axe's impact, in Tewip's words. A WCAG-tagged `moderate` is still worth fixing, not a blocker. */
const SEVERITY: Record<string, Severity> = {
  critical: 'blocker',
  serious: 'blocker',
  moderate: 'moderate',
  minor: 'minor',
};

/**
 * `wcag143` -> `1.4.3`. The first digit is the principle, the second the guideline, the rest the
 * criterion - so `wcag1411` is 1.4.11 and not 14.1.1, there being no fourteenth principle.
 */
function criterionFrom(tags: string[]): string | null {
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return null;
}

/** `wcag2a`, `wcag21aa`, `wcag22aa` -> the conformance level being claimed. */
function levelFrom(tags: string[]): 'A' | 'AA' | 'AAA' | null {
  let best: 'A' | 'AA' | 'AAA' | null = null;
  for (const tag of tags) {
    const m = /^wcag\d{1,2}(a{1,3})$/.exec(tag);
    if (!m) continue;
    const level = m[1].toUpperCase() as 'A' | 'AA' | 'AAA';
    // The strictest statement wins, so a rule tagged both A and AA is reported as AA.
    if (best === null || level.length > best.length) best = level;
  }
  return best;
}

/** `EN-9.1.4.3` -> `9.1.4.3`. */
function enClauseFrom(tags: string[]): string | null {
  for (const tag of tags) {
    const m = /^EN-(\d+(?:\.\d+)+)$/.exec(tag);
    if (m) return m[1];
  }
  return null;
}

/** axe writes its guidance as "Fix any of the following:\n  <reason>". One line reads better. */
function tidySummary(summary: string, fallback: string): string {
  const cleaned = summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Fix (any|all) of the following:$/.test(l))
    .join('; ');
  return cleaned === '' ? fallback : cleaned;
}

interface AxeNode {
  html?: unknown;
  target?: unknown;
  failureSummary?: unknown;
}

interface AxeRule {
  id?: unknown;
  impact?: unknown;
  tags?: unknown;
  help?: unknown;
  description?: unknown;
  nodes?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function fromRule(rule: AxeRule, page: string, kind: 'violation' | 'incomplete'): BrowserFinding[] {
  const tags = strings(rule.tags);
  const criterion = criterionFrom(tags);
  const help = text(rule.help) || text(rule.description);
  const id = text(rule.id);
  // No criterion and axe's own best-practice tag: somebody's good idea, not a standard. Reported,
  // but never as a barrier and never as something that fails a build.
  const advice = criterion === null && tags.includes('best-practice');
  const confidence = kind === 'incomplete' ? 'ask-a-person' : advice ? 'advice' : 'barrier';
  const nodes = Array.isArray(rule.nodes) ? (rule.nodes as AxeNode[]) : [];

  return nodes.map((node) => ({
    rule: id,
    tool: 'axe' as const,
    confidence,
    criterion,
    level: levelFrom(tags),
    en301549: enClauseFrom(tags),
    severity: advice ? 'minor' : (SEVERITY[text(rule.impact)] ?? 'moderate'),
    html: text(node.html).replace(/\s+/g, ' ').slice(0, 160),
    selector: strings(node.target).join(' '),
    page,
    why:
      kind === 'incomplete'
        ? `${help}. axe could not determine this one: ${tidySummary(text(node.failureSummary), 'no reason given')}`
        : help,
    next: tidySummary(text(node.failureSummary), help),
  }));
}

/**
 * What a run can be said to have checked.
 *
 * Built from every rule that *ran* - passing and inapplicable ones included - and not from the ones
 * that happened to find something. The difference matters in both directions: a contrast check that
 * ran and found nothing has still checked contrast, and a criterion is not covered merely because
 * some unrelated rule under the same number reported a violation.
 */
export interface AxeRun {
  findings: BrowserFinding[];
  /** Every page the run opened - including ones where everything passed, which are still checked. */
  pages: Set<string>;
  /** Every axe rule id that ran, whatever its outcome. */
  rulesRun: Set<string>;
  /** Every WCAG criterion those rules test, as bare numbers. */
  criteriaCovered: Set<string>;
}

const OUTCOMES = ['violations', 'incomplete', 'passes', 'inapplicable'] as const;

/** One axe result object: what `axe.run()` resolves to. */
function fromResult(result: Record<string, unknown>, page: string, run: AxeRun): void {
  // Recorded before any finding is read: a page on which every rule passed has still been opened,
  // and leaving it out made a clean page look like one the browser never visited.
  run.pages.add(page);
  for (const outcome of OUTCOMES) {
    for (const rule of (Array.isArray(result[outcome]) ? result[outcome] : []) as AxeRule[]) {
      const id = text(rule.id);
      if (id !== '') run.rulesRun.add(id);
      const criterion = criterionFrom(strings(rule.tags));
      if (criterion) run.criteriaCovered.add(criterion);
      // Only the two outcomes that need a person's attention become findings. A rule that passed
      // or did not apply is evidence of coverage, not something to report.
      if (outcome === 'violations') run.findings.push(...fromRule(rule, page, 'violation'));
      if (outcome === 'incomplete') run.findings.push(...fromRule(rule, page, 'incomplete'));
    }
  }
}

/** True of anything shaped like the object `axe.run()` resolves to. */
function looksLikeAxe(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.violations) || Array.isArray(v.incomplete) || Array.isArray(v.passes);
}

/**
 * Reads an axe report, in any of the shapes real suites write it.
 *
 * One run; an array of runs, which is what a suite checking several pages produces; or an array of
 * `{ url, result }` wrappers, which is what people write when they want to keep the page alongside
 * its findings. Guessing wrong here means reporting a clean page, so an unreadable file throws
 * rather than returning nothing.
 */
export function readAxeReport(path: string): AxeRun {
  let parsed: unknown;
  const raw = readFileSync(path, 'utf8');
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not JSON. Tewip reads the JSON an axe run writes.`);
  }

  const run: AxeRun = { findings: [], pages: new Set(), rulesRun: new Set(), criteriaCovered: new Set() };
  const pageOf = (v: Record<string, unknown>, fallback: string) => text(v.url) || text(v.page) || fallback;

  if (looksLikeAxe(parsed)) {
    fromResult(parsed, pageOf(parsed, path), run);
    return run;
  }

  if (Array.isArray(parsed)) {
    let read = 0;
    for (const entry of parsed) {
      if (looksLikeAxe(entry)) {
        fromResult(entry, pageOf(entry as Record<string, unknown>, path), run);
        read++;
        continue;
      }
      // A wrapper: { page | url, result: <axe run> }.
      if (typeof entry !== 'object' || entry === null) continue;
      const wrapper = entry as Record<string, unknown>;
      // axe records the page it actually ran against in `result.url`, which is authoritative.
      // A wrapper's own label is only a fallback for runs that did not keep it.
      if (looksLikeAxe(wrapper.result)) {
        fromResult(wrapper.result, pageOf(wrapper.result, pageOf(wrapper, path)), run);
        read++;
      }
    }
    if (read > 0 || parsed.length === 0) return run;
  }

  throw new Error(
    `${path} is JSON, but not an axe report: Tewip looked for a "violations" array, a list of runs, ` +
      'or a list of { page, result } wrappers. Write one with axe.run() in your Playwright, Cypress or jest-axe suite.',
  );
}

/**
 * The axe rule that tests the same thing as one of Tewip's source-read rules.
 *
 * Supersession is decided here, rule by rule, rather than by criterion. By criterion it is too
 * coarse and loses real findings: axe reporting `aria-required-children` means it checked *that*
 * part of 1.3.1, not that it looked at heading structure, which axe treats as best-practice and
 * tests under no criterion at all. Nineteen real heading findings disappeared that way before this
 * map existed.
 *
 * `click-without-keyboard` has no entry on purpose: axe has no equivalent rule, so a source finding
 * for it is never superseded by any run.
 */
export const EQUIVALENT_AXE_RULE: Readonly<Record<string, string>> = {
  'image-alt': 'image-alt',
  'input-label': 'label',
  'button-name': 'button-name',
  'link-name': 'link-name',
  'html-lang': 'html-has-lang',
  'iframe-title': 'frame-title',
  'zoom-blocked': 'meta-viewport',
  'nested-interactive': 'nested-interactive',
  'aria-hidden-focusable': 'aria-hidden-focus',
  'duplicate-id': 'duplicate-id',
  'aria-unknown': 'aria-valid-attr',
  'positive-tabindex': 'tabindex',
  'autoplay-sound': 'no-autoplay-audio',
  'heading-skip': 'heading-order',
};
