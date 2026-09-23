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
/**
 * The line is making or sending something: this is data, and making it unique is the fix.
 * The object-property form matters most and was missing at first - real test data is written
 * `name: "Secondi"` and `employee_name="Nguyen Van A"` far more often than it is assigned to its
 * own variable, so without it four real creation sites were misread as assertions.
 */
const CREATING =
  /\b(?:const|let|var)\s+[\w$]+\s*=|[\w$]+\s*[:=]\s*['"`]|\b(?:create|insert|add|register|signup|signUp|post|put|save|seed|make|new)\w*\s*\(|\.\s*(?:fill|type|values|send)\s*\(/;

/**
 * The value is naming an element, not creating a record. `getByRole('button', { name: 'Submit' })`
 * reads exactly like an object property to the pattern above, and rewriting it would point the test
 * at an element that does not exist - breaking the test rather than fixing the collision. A unit
 * test caught this before any real data did.
 */
const A_SELECTOR = /\bgetBy\w+\s*\(|\bfindBy\w+\s*\(|\blocator\s*\(|\bcy\.get\s*\(|querySelector|\bBy\.\w+\s*\(|\bselector\b/i;

export type SiteChoice =
  | { site: LiteralSite; why: string }
  | { site: null; reason: 'value-only-asserted' | 'value-ambiguous' | 'value-also-asserted'; why: string };

/**
 * Picks the one occurrence it is safe to make unique, given the whole file.
 */
export function chooseDataSite(source: string, sites: LiteralSite[], value: string): SiteChoice {
  const asserting = sites.filter((s) => ASSERTING.test(lineOf(source, s)));
  const creating = sites.filter((s) => {
    const line = lineOf(source, s);
    return CREATING.test(line) && !ASSERTING.test(line) && !A_SELECTOR.test(line);
  });

  if (creating.length === 0) {
    return {
      site: null,
      reason: 'value-only-asserted',
      why:
        sites.length === 1
          ? `"${value}" appears only in ${lineOf(source, sites[0]).trim().slice(0, 60)}, where the test is checking it rather than creating anything. Making that unique would change what the test asserts instead of fixing the collision.`
          : `"${value}" is written ${sites.length} times in the test and none of them creates anything: they are assertions or arguments Tewip cannot tell apart. A person should decide which one is the data.`,
    };
  }
  if (creating.length > 1) {
    return {
      site: null,
      reason: 'value-ambiguous',
      why: `"${value}" is created in ${creating.length} places (lines ${creating.map((s) => s.line).join(', ')}). Making only one unique would break the link between them, so this needs a person.`,
    };
  }
  if (asserting.length > 0) {
    // The commonest real shape of all: `name: "Secondi"` on one line and
    // `expect(body.data.name).toBe("Secondi")` a few lines down. Making the data unique without
    // rewriting the assertion turns a flaky test into a failing one, and rewriting both is a bigger
    // change than this fix is allowed to make.
    return {
      site: null,
      reason: 'value-also-asserted',
      why: `"${value}" is created on line ${creating[0].line} and also checked on line ${asserting[0].line}. Making the data unique would leave the assertion looking for the old value, so the two have to change together - which is a person's call, not this fix's.`,
    };
  }
  return {
    site: creating[0],
    why: sites.length === 1 ? `"${value}" is written once in the test, where the record is created` : `"${value}" is written ${sites.length} times; line ${creating[0].line} is the one that creates the record`,
  };
}

const lineOf = (source: string, site: LiteralSite): string => source.split('\n')[site.line - 1] ?? '';
