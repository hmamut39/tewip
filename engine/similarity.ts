// Textual similarity between a failing locator and elements in the page snapshot.
// Used by the LOCATOR_DRIFT rule: "element not found, but something like it exists".
import type { SnapshotElement } from './snapshot.ts';

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'your', 'my', 'data', 'testid', 'test', 'id', 'qa', 'js', 'el', 'div', 'span']);
const SYNONYMS: Record<string, string> = {
  btn: 'button',
  input: 'textbox',
  field: 'textbox',
  image: 'img',
  icon: 'img',
  anchor: 'link',
  lnk: 'link',
  dropdown: 'combobox',
  select: 'combobox',
};
export const ROLE_WORDS = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'heading', 'img', 'listitem', 'tab', 'menuitem', 'option', 'dialog', 'searchbox', 'switch', 'slider']);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !STOP_WORDS.has(t))
    .map((t) => SYNONYMS[t] ?? t);
}

export interface LocatorWords {
  tokens: string[];
  /** Role from getByRole('<role>', ...), when the locator names one. */
  role?: string;
}

/** The human words inside a locator string, without Playwright API names. */
export function locatorWords(locator: string): LocatorWords {
  const role = locator.match(/getByRole\(\s*['"]([a-z]+)['"]/)?.[1];
  const stripped = locator
    .replace(/\b(?:locator|getBy[A-Z]\w*|frameLocator|internal:[\w-]+)\b/g, ' ')
    .replace(/\b(?:name|exact|hasText|hasNotText|has|nth|first|last|filter)\b\s*[:(]?/g, ' ');
  return { tokens: tokenize(stripped), role };
}

function bigrams(word: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2));
  return out;
}

/** 1 for equal words, high for prefixes and small typos, 0 for unrelated words. */
function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  const [x, y] = [bigrams(a), bigrams(b)];
  const shared = [...x].filter((g) => y.has(g)).length;
  const dice = x.size + y.size === 0 ? 0 : (2 * shared) / (x.size + y.size);
  return dice >= 0.7 ? dice : 0;
}

/**
 * Soft Dice overlap of word sets. Role words (button, link, ...) count toward the score
 * but can't carry it alone: at least one content word must match.
 */
export function similarity(target: LocatorWords, element: SnapshotElement): number {
  const content = target.tokens.filter((t) => !ROLE_WORDS.has(t));
  const wantsRole = target.tokens.some((t) => ROLE_WORDS.has(t));
  const words = tokenize(`${element.name} ${element.text}`);
  const candidate = wantsRole ? [...new Set([...words, ...tokenize(element.role)])] : words;
  if (content.length === 0 || words.length === 0) return 0;

  const best = (t: string) => Math.max(0, ...candidate.map((c) => wordSimilarity(t, c)));
  if (!content.some((t) => best(t) > 0)) return 0;
  const matched = target.tokens.reduce((sum, t) => sum + best(t), 0);
  const score = Math.min(1, (2 * matched) / (target.tokens.length + candidate.length));
  return target.role && target.role !== element.role ? score * 0.7 : score;
}

export interface RankedElement {
  element: SnapshotElement;
  score: number;
}

/** Snapshot elements most similar to the locator, best first; zero scores dropped. */
export function rankCandidates(locator: string, elements: SnapshotElement[]): RankedElement[] {
  const target = locatorWords(locator);
  return elements
    .map((element) => ({ element, score: similarity(target, element) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function describeElement(element: SnapshotElement): string {
  const label = element.name || element.text;
  return label ? `${element.role} "${label}"` : element.role;
}
