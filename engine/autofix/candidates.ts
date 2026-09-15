// Replacement locators for a drifted one: the page's most similar elements, written as
// role-based locators (the robust kind), best first.
import { DRIFT_MIN_SIMILARITY } from '../rules.ts';
import { rankCandidates } from '../similarity.ts';
import type { SnapshotElement } from '../snapshot.ts';

export interface Candidate {
  expression: string;
  element: SnapshotElement;
  score: number;
}

const ROLE_LOCATABLE = new Set(['button', 'link', 'heading', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem', 'option', 'searchbox', 'switch']);
const quote = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

export function locatorFor(el: SnapshotElement): string | null {
  const name = el.name || el.text;
  if (!name) return null;
  return ROLE_LOCATABLE.has(el.role) ? `getByRole(${quote(el.role)}, { name: ${quote(name)}, exact: true })` : `getByText(${quote(name)}, { exact: true })`;
}

export function candidatesFor(printedLocator: string, snapshot: SnapshotElement[], max = 3): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const { element, score } of rankCandidates(printedLocator, snapshot)) {
    if (score < DRIFT_MIN_SIMILARITY || out.length >= max) break;
    const expression = locatorFor(element);
    if (!expression || seen.has(expression)) continue;
    seen.add(expression);
    out.push({ expression, element, score });
  }
  return out;
}
