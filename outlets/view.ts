// Shared pieces of every role's view: how one failure is printed (always with its confidence,
// data source, next action and evidence), where each category must be routed, and the check
// behind the phase-4 metric.
import type { Diagnosis, DiagnosisCategory } from '../reporters/types.ts';
import type { TriageItem } from './items.ts';

export type Role = 'developer' | 'sdet' | 'devops' | 'business' | 'senior-engineer' | 'architect' | 'lead';

export interface View {
  id: string;
  role: Role;
  title: string;
  /** "run": one CI run. "window": every run in the dataset. */
  scope: 'run' | 'window';
  /** Every failure the view shows individually. */
  items: TriageItem[];
  markdown: string;
}

/**
 * Phase-4 routing: the views each category must reach. Run-level views only; the window
 * views aggregate. Low-confidence and UNKNOWN failures always land on the SDET board.
 */
export const ROUTES: Record<DiagnosisCategory, Role[]> = {
  REAL_BUG: ['developer', 'business', 'sdet'],
  ENV: ['devops', 'developer', 'sdet'],
  TIMING: ['developer', 'sdet'],
  LOCATOR_DRIFT: ['developer', 'sdet'],
  TEST_DATA: ['developer', 'sdet'],
  UNKNOWN: ['developer', 'sdet'],
};

export const PLAIN_CATEGORY: Record<DiagnosisCategory, string> = {
  REAL_BUG: 'product problem',
  ENV: 'test environment problem',
  TIMING: 'unreliable (flaky) test',
  LOCATOR_DRIFT: 'test needs updating after a UI change',
  TEST_DATA: 'test data problem',
  UNKNOWN: 'not understood yet',
};

/** A zero-width space: invisible, but it stops GitHub from reading the text around it as syntax. */
const ZWSP = '​';

/**
 * Markdown-safe single line from a test run: no backticks, pipes or line breaks. Test names and
 * error messages come from the pull request's own code, so on a public repository its author
 * controls them: without this they could ping people (@name), embed tracking images or disguised
 * links, or inject HTML into the agent's comment.
 */
export const clean = (s: string) =>
  s
    .replaceAll('`', "'")
    .replaceAll('|', '/')
    .replaceAll('<', '&lt;')
    .replace(/@(?=[\w-])/g, `@${ZWSP}`) // "@name" reads the same but notifies no one
    .replace(/!?\[([^\]\n]*)\]\(/g, `[$1]${ZWSP}(`) // links and images show as plain text
    .replace(/\s+/g, ' ')
    .trim();

export const confidenceText = (d: Diagnosis) => (d.category === 'UNKNOWN' ? 'confidence 0.00 (undecided)' : `confidence ${d.confidence.toFixed(2)}`);

export const diagnosisLine = (i: TriageItem) => `${i.diagnosis.category}, ${confidenceText(i.diagnosis)}, source: ${clean(i.source)}`;

export const actionLine = (i: TriageItem) => `${i.action.owner}${i.action.autonomous ? ', the agent may do this on its own' : ''}): ${clean(i.action.summary)}`;

/** The standard block for one failure. Views may add lines after it, never drop these. */
export function itemBlock(i: TriageItem, extra: string[] = []): string {
  return [
    `- **${clean(i.title)}** (\`${clean(i.file)}\`, run ${clean(i.runId)})`,
    `  - Diagnosis: ${diagnosisLine(i)}`,
    `  - Next action (${actionLine(i)}`,
    `  - Evidence: ${i.evidence.length > 0 ? i.evidence.map(clean).join(' · ') : '(none)'}`,
    ...extra.map((line) => `  - ${line}`),
  ].join('\n');
}

/** Why an item is not properly shown in a view, or null when it is. */
export function missingFromView(view: View, i: TriageItem): string | null {
  if (!view.items.includes(i)) return `not listed in ${view.id}`;
  if (!view.markdown.includes(diagnosisLine(i))) return `${view.id} lacks its diagnosis, confidence or source`;
  if (!view.markdown.includes(clean(i.action.summary))) return `${view.id} lacks its next action`;
  if (i.evidence.length === 0 || !view.markdown.includes(clean(i.evidence[0]))) return `${view.id} lacks its evidence`;
  return null;
}

/** Header line that ties a view's numbers to the dataset they came from. */
export const sourceNote = (dataset: string) =>
  `> Data: \`${dataset}\`. Every diagnosis shows its confidence and whether rules or the AI model produced it. Measured accuracy on real CI data: see eval/README.md.`;
