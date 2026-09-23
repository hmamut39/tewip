// Design drift: what the design says, next to what the page says.
//
// The page side is Playwright's accessibility snapshot, which is what a screen reader and a test
// both see. Comparing that against a design's words and controls is a comparison Tewip can defend.
// Comparing pixels is not, so it never does.
import type { DesignCheck } from './frame.ts';

export interface PageElement {
  role: string;
  name: string;
}

export interface Drift {
  check: DesignCheck;
  /** met: the page agrees. renamed: same control, different words. role: the words are there but not
   *  as that kind of control. missing: not on the page at all. */
  verdict: 'met' | 'renamed' | 'role' | 'missing';
  /** What the page has instead, when there is something. */
  found?: string;
}

const normalize = (text: string): string =>
  text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const words = (text: string): string[] => normalize(text).split(/[^a-z0-9']+/).filter((w) => w.length > 1);

/** How much two names share, 0 to 1, by the words in them. */
export function nameOverlap(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared++;
  return shared / Math.max(left.size, right.size);
}

// A snapshot line looks like `- button "Sign in"`, `- heading "Welcome" [level=1]:` or
// `- text: some words`. The name is read between the first and last quote on the line, which is
// right even when the name itself contains an escaped quote.
const HEAD = /^\s*-\s+([a-zA-Z][\w-]*)(.*)$/;
const BACKSLASH = String.fromCharCode(92);

/** The elements in a Playwright aria snapshot, and every loose word on the page. */
export function pageElements(aria: string): { elements: PageElement[]; text: string } {
  const elements: PageElement[] = [];
  const loose: string[] = [];
  for (const line of aria.split('\n')) {
    const m = HEAD.exec(line);
    if (!m) continue;
    const [, role, rest] = m;
    const first = rest.indexOf('"');
    const last = rest.lastIndexOf('"');
    const quoted = first >= 0 && last > first ? rest.slice(first + 1, last).split(BACKSLASH + '"').join('"') : '';
    const after = (first >= 0 && last > first ? rest.slice(last + 1) : rest).replace(/\s*\[[^\]]*\]/g, '').replace(/^\s*:?\s*/, '').trim();
    if (role === 'text') {
      const words = after || quoted;
      if (words) loose.push(words);
      continue;
    }
    const name = (quoted || after).trim();
    elements.push({ role, name });
    if (name) loose.push(name);
    if (quoted && after) loose.push(after);
  }
  return { elements, text: loose.join('\n') };
}

/** Roles a page may legitimately use for what a design drew as one thing. */
const ALSO_COUNTS: Record<string, string[]> = {
  button: ['link', 'menuitem', 'tab'],
  textbox: ['searchbox', 'combobox'],
  searchbox: ['textbox'],
  link: ['button'],
  combobox: ['listbox', 'button'],
  switch: ['checkbox'],
  heading: [],
};

const RENAMED_ENOUGH = 0.5;

/** Each design check against the page, said plainly. */
export function compareDesign(checks: DesignCheck[], aria: string): Drift[] {
  const { elements, text } = pageElements(aria);
  const pageText = normalize(text);
  const drifts: Drift[] = [];

  for (const check of checks) {
    if (check.kind === 'landmark') {
      // A region has no name to compare: either the page marks it up as that kind of region or it
      // does not, which is the same thing a screen reader finds.
      const role = check.role ?? '';
      const there = elements.find((e) => e.role === role);
      drifts.push(there ? { check, verdict: 'met', found: role } : { check, verdict: 'missing' });
      continue;
    }
    if (check.kind === 'text') {
      if (pageText.includes(normalize(check.name))) {
        drifts.push({ check, verdict: 'met' });
        continue;
      }
      const closest = text
        .split('\n')
        .map((line) => ({ line: line.trim(), score: nameOverlap(check.name, line) }))
        .sort((a, b) => b.score - a.score)[0];
      drifts.push(closest && closest.score >= RENAMED_ENOUGH ? { check, verdict: 'renamed', found: closest.line } : { check, verdict: 'missing' });
      continue;
    }

    const role = check.role ?? '';
    const sameRole = elements.filter((e) => e.role === role || (ALSO_COUNTS[role] ?? []).includes(e.role));
    const exact = sameRole.find((e) => normalize(e.name) === normalize(check.name));
    if (exact) {
      drifts.push({ check, verdict: 'met', found: `${exact.role} "${exact.name}"` });
      continue;
    }
    const near = sameRole
      .map((e) => ({ e, score: nameOverlap(check.name, e.name) }))
      .sort((a, b) => b.score - a.score)
      .find((c) => c.score >= RENAMED_ENOUGH);
    if (near) {
      drifts.push({ check, verdict: 'renamed', found: `${near.e.role} "${near.e.name}"` });
      continue;
    }
    // The words are on the page, but not as the kind of thing the design drew.
    const elsewhere = elements.find((e) => normalize(e.name) === normalize(check.name)) ?? (pageText.includes(normalize(check.name)) ? { role: 'text', name: check.name } : undefined);
    drifts.push(elsewhere ? { check, verdict: 'role', found: `${elsewhere.role} "${elsewhere.name}"` } : { check, verdict: 'missing' });
  }
  return drifts;
}

const SAYS: Record<Drift['verdict'], string> = {
  met: 'matches',
  renamed: 'different words',
  role: 'not that kind of control',
  missing: 'not on the page',
};

/** The report a designer or developer reads: design on the left, page on the right. */
export function renderDrift(drifts: Drift[], design: string, pageUrl: string): string {
  const differences = drifts.filter((d) => d.verdict !== 'met');
  const lines = [
    `Design: ${design}`,
    `Page:   ${pageUrl}`,
    '',
    `${drifts.length} check(s) from the design, ${drifts.length - differences.length} met, ${differences.length} different.`,
    '',
  ];
  for (const d of differences) {
    const what = d.check.kind === 'role' ? `${d.check.role} "${d.check.name}"` : d.check.kind === 'landmark' ? `a ${d.check.role} region` : `text "${d.check.name}"`;
    lines.push(`  ${SAYS[d.verdict]}`);
    lines.push(`    design says: ${what}`);
    lines.push(`    page says:   ${d.found ?? 'nothing like it'}`);
    lines.push(`    in the design: ${d.check.from}`);
    lines.push('');
  }
  if (differences.length === 0) lines.push('  The page says everything the design says.', '');
  lines.push('Checked: the words in the design, and the controls its layer names imply. Not pixels,');
  lines.push('colours or spacing - Tewip only reports what it can read on both sides.');
  return lines.join('\n');
}
