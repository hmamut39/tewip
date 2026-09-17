// LOCATOR_DRIFT rules: the element the test means still exists, but its locator no longer
// finds it (renamed), or now finds several elements (the page gained a similar one).
import type { Evidence } from '../reporters/types.ts';
import { extractLocator, isElementNotFound, locatorName, strictModeViolation } from './error-parse.ts';
import type { Rule, RuleOutcome } from './rules.ts';
import { describeElement, rankCandidates } from './similarity.ts';

export const DRIFT_MIN_SIMILARITY = 0.6;
/** Best and runner-up drift candidates closer than this are treated as ambiguous. */
const DRIFT_AMBIGUITY_GAP = 0.05;

function declined(source: string, message: string, data?: Record<string, unknown>): RuleOutcome {
  return { category: null, confidence: 0, evidence: [{ source, message, data }] };
}

export const locatorDrift: Rule = {
  id: 'locator-drift',
  evaluate({ record, loadSnapshot }) {
    if (!isElementNotFound(record.errorMessage)) return null;
    const locator = extractLocator(record.errorMessage);
    if (!locator) return declined(this.id, 'element not found, but the locator could not be read from the error');
    const snapshot = loadSnapshot();
    if (!snapshot) return declined(this.id, `${locator} not found; no page snapshot to look for a renamed element`, { locator });

    const [best, second] = rankCandidates(locator, snapshot);
    if (!best || best.score < DRIFT_MIN_SIMILARITY) {
      const closest = best ? `closest: ${describeElement(best.element)} at ${best.score.toFixed(2)}` : `none of ${snapshot.length} elements share a word with it`;
      return declined(this.id, `${locator} not found and nothing similar is on the page (${closest})`, { locator });
    }

    const candidate = best.element;
    const evidence: Evidence[] = [
      {
        source: this.id,
        message: `${locator} not found, but the page has ${describeElement(candidate)} (similarity ${best.score.toFixed(2)})`,
        data: { locator, candidate, similarity: best.score },
      },
    ];
    let confidence = 0.5 + 0.45 * best.score;
    if (second && best.score - second.score < DRIFT_AMBIGUITY_GAP) {
      confidence -= 0.1;
      evidence.push({ source: this.id, message: `ambiguous: ${describeElement(second.element)} is almost as similar (${second.score.toFixed(2)})` });
    }
    return { category: 'LOCATOR_DRIFT', confidence, evidence };
  },
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An action (click, fill…) whose locator now matches several elements, exactly one of which
 * carries the locator's name as a whole word: e.g. `name: 'Edit'` resolving to "Editor canvas"
 * twice and "Edit link" once. Playwright matches names by substring, so a new element with a
 * similar name broke the locator; the element the test means is the one with the whole word,
 * and Playwright's error already prints a unique locator for it. Found in real Gutenberg fixes
 * (label rule v4, rules-5). Assertions decline: a toBeHidden() that finds extra elements is as
 * likely a behaviour change as a locator problem.
 */
export const locatorDriftStrict: Rule = {
  id: 'locator-drift-strict',
  evaluate({ record }) {
    const violation = strictModeViolation(record.errorMessage);
    if (!violation) return null;
    const { locator, count, isAction, elements } = violation;
    const name = locatorName(locator);
    if (!name) return declined(this.id, `${locator} matched ${count} elements, and it names no element to pick among them`, { locator });
    const exact = elements.filter((e) => e.name?.toLowerCase() === name.toLowerCase());
    const word = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`, 'iu');
    const matches = exact.length > 0 ? exact : elements.filter((e) => e.name && word.test(e.name));
    const names = elements.map((e) => `"${e.name ?? e.locator}"`).join(', ');
    if (matches.length === 0) {
      // Checked fact for the AI: substring matches of other elements say nothing about whether
      // the intended element still exists, which LOCATOR_DRIFT requires.
      return declined(this.id, `${locator} matched ${count} elements (${names}), but none is named "${name}": only other elements whose names contain that text, so this is no evidence that the intended element still exists`, { locator });
    }
    if (!isAction) return declined(this.id, `an assertion's locator ${locator} matched ${count} elements (${names}): the page may have changed behaviour, not only names`, { locator });
    if (matches.length > 1) {
      return declined(this.id, `${locator} matched ${count} elements (${names}) and ${matches.length} of them are named with "${name}", so the intended one is unclear`, { locator });
    }
    const [target] = matches;
    const others = elements.filter((e) => e !== target).map((e) => `"${e.name ?? e.locator}"`);
    return {
      category: 'LOCATOR_DRIFT',
      confidence: 0.9,
      evidence: [
        {
          source: this.id,
          message: `${locator} now matches ${count} elements: the page gained ${others.join(', ')} next to the intended ${target.locator}`,
          data: { locator, candidate: { role: target.role, name: target.name }, replacement: target.locator, similarity: 1 },
        },
      ],
    };
  },
};
