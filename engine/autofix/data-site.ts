// Which occurrence of a colliding value may be rewritten - and when none of them may be.
//
// `findLiteral` returns every place the value is written in the test, and the fix used to take the
// first. Measuring this against real commits showed what that risks: a value that collides in the
// database is often also a value the test *checks*. If "admin" appears first inside
// `await expect(page.getByText('admin')).toBeVisible()`, rewriting that occurrence changes what the
// test asserts while leaving the collision in place - a test that now passes for the wrong reason,
// which is worse than the flake it was meant to fix.
//
// So the rule here is the one the rest of this phase already follows: prefer the occurrence that
// creates data, never touch one that is only being checked, and where it is genuinely unclear,
// refuse and say why rather than guess.
import type { LiteralSite } from './data.ts';

/** The line is checking the value rather than creating anything with it. */
const ASSERTING = /\bexpect\s*\(|\.\s*should\s*\(|\bassert(?:Equals?|That|ion)?\b|\btoBe\w*\s*\(|\bto(?:Have|Contain)\w*\s*\(/;
/** The line is making or sending something: this is data, and making it unique is the fix. */
const CREATING = /\b(?:const|let|var)\s+[\w$]+\s*=|[\w$]+\s*[:=]\s*$|\b(?:create|insert|add|register|signup|signUp|post|put|save|seed|make|new)\w*\s*\(|\.\s*fill\s*\(|\.\s*type\s*\(/;

export type SiteChoice =
  | { site: LiteralSite; why: string }
  | { site: null; reason: 'value-only-asserted' | 'value-ambiguous'; why: string };

/**
 * Picks the one occurrence it is safe to make unique, given the whole file.
 */
export function chooseDataSite(source: string, sites: LiteralSite[], value: string): SiteChoice {
  if (sites.length === 1) {
    const only = sites[0];
    return lineOf(source, only).match(ASSERTING) && !lineOf(source, only).match(CREATING)
      ? {
          site: null,
          reason: 'value-only-asserted',
          why: `"${value}" appears in ${source.split('\n')[only.line - 1].trim().slice(0, 60)}, where the test is checking it rather than creating it. Making that unique would change what the test asserts instead of fixing the collision.`,
        }
      : { site: only, why: `"${value}" is written once in the test` };
  }

  const creating = sites.filter((s) => CREATING.test(lineOf(source, s)) && !ASSERTING.test(lineOf(source, s)));
  if (creating.length === 1) return { site: creating[0], why: `"${value}" is written ${sites.length} times; line ${creating[0].line} is the one that creates the record` };
  if (creating.length === 0) {
    return {
      site: null,
      reason: 'value-only-asserted',
      why: `"${value}" is written ${sites.length} times in the test, and none of them creates anything: they are assertions or arguments Tewip cannot tell apart. A person should decide which one is the data.`,
    };
  }
  // Several places really do create data with this value, and they may have to change together.
  return {
    site: null,
    reason: 'value-ambiguous',
    why: `"${value}" is created in ${creating.length} places (lines ${creating.map((s) => s.line).join(', ')}). Making only one unique would break the link between them, so this needs a person.`,
  };
}

const lineOf = (source: string, site: LiteralSite): string => source.split('\n')[site.line - 1] ?? '';
