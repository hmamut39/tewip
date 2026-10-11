// Phase 29: joining what was read from the source to what was seen in the browser.
//
// The two are not equal witnesses. For any criterion a browser run actually checked, the browser
// saw the rendered page with its stylesheets, its JavaScript and its real DOM - so its answer wins,
// and repeating the source-read finding for the same criterion would be the same barrier counted
// twice. For every other criterion the source read is all there is.
//
// What must not happen is a finding disappearing quietly. A source finding set aside because the
// browser covered its criterion is counted and named in the report, so the number a team saw
// yesterday never drops without an explanation.
import type { Finding } from './checks.ts';
import { EQUIVALENT_AXE_RULE, type AxeRun, type BrowserFinding } from './reports.ts';
import { NOT_CHECKED, RULES } from './wcag.ts';

/** `1.1.1 Non-text Content` -> `1.1.1`, so a criterion from either source can be compared. */
export function criterionNumber(criterion: string): string {
  return /^\d+(?:\.\d+)*/.exec(criterion.trim())?.[0] ?? '';
}

/** The criterion a source-read rule belongs to, as a bare number. */
export function criterionOfRule(rule: string): string {
  const r = RULES[rule];
  return r ? criterionNumber(r.criterion) : '';
}

export interface Merged {
  /** Source findings still worth reporting: the browser did not cover their criterion. */
  kept: Finding[];
  /** Source findings the browser run supersedes, counted so the drop is explainable. */
  superseded: Finding[];
  /** Which criteria the browser settled, as bare numbers. */
  covered: Set<string>;
}

/**
 * Sets aside the source findings the run actually re-checked, rule by rule.
 *
 * The test is whether the *equivalent axe rule ran*, not whether axe found something and not
 * whether some other rule under the same criterion ran. A rule that ran and passed still
 * supersedes - axe looked at the rendered page and disagreed, which is the better evidence. A rule
 * with no axe equivalent, like `click-without-keyboard`, is never superseded by anything.
 */
export function merge(source: Finding[], run: AxeRun, root: string): Merged {
  const opened = pagesAsFiles(run, root);
  const kept: Finding[] = [];
  const superseded: Finding[] = [];
  for (const f of source) {
    const equivalent = EQUIVALENT_AXE_RULE[f.rule];
    // Both conditions, and the second is the one that was missing. A run of nine pages does not
    // supersede a finding in the hundredth file it never opened: on bootstrap that silently
    // discarded all 44 source findings, including every one in the example pages axe never saw.
    // A component file is never a page a browser opens, so in a React or Vue project nothing is
    // superseded at all - correctly, because the source and the rendered output are two artefacts
    // and neither is evidence about the other.
    if (equivalent !== undefined && run.rulesRun.has(equivalent) && opened.has(f.file)) superseded.push(f);
    else kept.push(f);
  }
  return { kept, superseded, covered: run.criteriaCovered };
}

/** The pages a run opened, as repository-relative paths, for the ones that were local files. */
export function pagesAsFiles(run: AxeRun, root: string): Set<string> {
  const out = new Set<string>();
  const base = root.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  for (const page of run.pages) {
    // `file:///C:/repo/a.html` -> `C:/repo/a.html`, but `file:///repo/a.html` -> `/repo/a.html`.
    // Stripping every slash after the scheme is wrong on anything but Windows: the third one is
    // the root, not padding.
    const stripped = decodeURIComponent(page.replace(/^file:\/\//i, '')).replaceAll('\\', '/');
    const path = /^\/[A-Za-z]:/.test(stripped) ? stripped.slice(1) : stripped;
    const lower = path.toLowerCase();
    if (lower.startsWith(`${base}/`)) out.add(path.slice(base.length + 1));
  }
  return out;
}

/**
 * What is still unchecked once the browser run is counted.
 *
 * This is the payoff of the phase and the reason it is worth building: the list of criteria Tewip
 * admits it cannot reach should get shorter when real evidence arrives, rather than being printed
 * unchanged beneath a browser run that already settled half of it.
 */
export function stillNotChecked(rulesRun: Set<string>): ReadonlyArray<{ criterion: string; why: string }> {
  return NOT_CHECKED.filter((n) => n.settledBy === undefined || !rulesRun.has(n.settledBy));
}

/** The criteria from NOT_CHECKED that this run did settle, for the report to say so. */
export function nowChecked(rulesRun: Set<string>): ReadonlyArray<{ criterion: string; why: string }> {
  return NOT_CHECKED.filter((n) => n.settledBy !== undefined && rulesRun.has(n.settledBy));
}

const SEVERITY_ORDER = { blocker: 0, serious: 1, moderate: 2, minor: 3 } as const;

export function worstBrowserFirst(a: BrowserFinding, b: BrowserFinding): number {
  const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (d !== 0) return d;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return a.selector < b.selector ? -1 : 1;
}

/** Groups by rule, keeping the order the comparator produced. */
function byRule(findings: BrowserFinding[]): Map<string, BrowserFinding[]> {
  const out = new Map<string, BrowserFinding[]>();
  for (const f of [...findings].sort(worstBrowserFirst)) {
    const list = out.get(f.rule);
    if (list) list.push(f);
    else out.set(f.rule, [f]);
  }
  return out;
}

/** How a browser finding names its standard: both WCAG and the clause the EAA cites. */
export function standardOf(f: BrowserFinding): string {
  if (!f.criterion) return 'no criterion - this is a best-practice rule, not a standard';
  const en = f.en301549 ? `, EN 301 549 clause ${f.en301549}` : '';
  return `WCAG 2.2 ${f.criterion} (${f.level ?? 'A'})${en}`;
}

export function renderBrowserSection(title: string, findings: BrowserFinding[], lines: string[], limit = 8): void {
  if (findings.length === 0) return;
  lines.push(`## ${title}`, '');
  for (const [rule, found] of byRule(findings)) {
    lines.push(`### ${rule} - ${found.length} ${found.length === 1 ? 'place' : 'places'}`, '');
    lines.push(`${standardOf(found[0])}, ${found[0].severity}.`, '');
    lines.push(`${found[0].why}`, '');
    for (const f of found.slice(0, limit)) {
      lines.push(`- \`${f.selector}\``);
      lines.push(`  - \`${f.html}\``);
      if (f.next && f.next !== found[0].why) lines.push(`  - ${f.next}`);
    }
    if (found.length > limit) lines.push(`- ...and ${found.length - limit} more of the same.`);
    lines.push('');
  }
}

/** The pages a browser run covered, which bounds everything it can be said to prove. */
export function pagesIn(run: AxeRun): string[] {
  return [...run.pages].sort();
}
