// Regenerates engine/access/axe-rules.ts from axe-core itself.
//
// That table says which WCAG criterion each axe rule tests, which Phase 29 needs to tell a legal
// failure from somebody's good idea, and which a Lighthouse report does not carry. Writing it by
// hand would mean a hundred remembered mappings between rule ids and WCAG numbers, and a wrong
// criterion printed beside a finding is worse than no criterion at all. So it is generated, and
// this is the generator.
//
// Run it after upgrading axe-core:
//
//   npm i --no-save axe-core @playwright/test
//   node scripts/axe-rules.ts
//
// axe has to run in a browser to expose its catalogue, so this drives Playwright's Chromium. Both
// packages are dev-only: Tewip itself has no runtime dependency on either.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');

const axePath = require.resolve('axe-core/axe.min.js');
const axeSource = readFileSync(axePath, 'utf8');

interface Rule {
  id: string;
  tags: string[];
}

const criterionOf = (tags: string[]): string | null => {
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return null;
};

const levelOf = (tags: string[]): string | null => {
  let best: string | null = null;
  for (const tag of tags) {
    const m = /^wcag\d{1,2}(a{1,3})$/.exec(tag);
    if (!m) continue;
    const level = m[1].toUpperCase();
    if (best === null || level.length > best.length) best = level;
  }
  return best;
};

const enOf = (tags: string[]): string | null => {
  for (const tag of tags) {
    const m = /^EN-(\d+(?:\.\d+)+)$/.exec(tag);
    if (m) return m[1];
  }
  return null;
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><html lang="en"><body><main>x</main></body></html>');
await page.addScriptTag({ content: axeSource });
const { version, rules } = await page.evaluate(() => {
  const axe = (globalThis as unknown as { axe: { version: string; _audit: { rules: Rule[] } } }).axe;
  return { version: axe.version, rules: axe._audit.rules.map((r) => ({ id: r.id, tags: r.tags })) };
});
await browser.close();

const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : 1));
const withCriterion = sorted.filter((r) => criterionOf(r.tags) !== null).length;
const quote = (v: string | null) => (v === null ? 'null' : `'${v}'`);
const body = sorted
  .map((r) => `  '${r.id}': { criterion: ${quote(criterionOf(r.tags))}, level: ${quote(levelOf(r.tags))}, en301549: ${quote(enOf(r.tags))} },`)
  .join('\n');

const NL = String.fromCharCode(10);
const head = [
  '// Phase 32: what each axe rule tests, taken from axe-core itself.',
  '//',
  "// Lighthouse's accessibility audits are axe rules - the ids are identical - but a Lighthouse report",
  '// does not carry axe\'s tags, so it says "landmark-one-main" and nothing about which criterion that',
  "// is, or whether it is a criterion at all. Phase 29 needs that to tell a legal failure from somebody's",
  "// good idea, and 42% of axe's output is the latter.",
  '//',
  '// Writing the table by hand was the reason Phase 31 left this undone: a remembered mapping between a',
  '// hundred rule ids and WCAG numbers is a mapping with mistakes in it, and a wrong criterion beside a',
  '// finding is worse than no criterion. So the table is **generated**: axe-core is loaded in a browser',
  '// and asked for its own rule catalogue, and these are its tags, parsed the same way Phase 29 parses',
  '// the tags on a live run.',
  '//',
  `// Generated from axe-core ${version}. ${sorted.length} rules: ${withCriterion} carry a WCAG criterion,`,
  `// ${sorted.length - withCriterion} are tagged best-practice only and test no standard at all.`,
  '// Regenerate with: node scripts/axe-rules.ts - never by editing this file.',
  '',
  'export interface AxeRuleFacts {',
  '  /** The WCAG criterion this rule tests, or null when it tests nobody\'s standard. */',
  '  criterion: string | null;',
  "  level: 'A' | 'AA' | 'AAA' | null;",
  '  /** The clause in EN 301 549, which is what the European Accessibility Act cites. */',
  '  en301549: string | null;',
  '}',
  '',
  `export const AXE_CORE_VERSION = '${version}';`,
  '',
  'export const AXE_RULES: Readonly<Record<string, AxeRuleFacts>> = {',
].join(NL);

const tail = ['};', '', '/** What a rule tests, or undefined when axe has no rule by that name. */', 'export function factsFor(ruleId: string): AxeRuleFacts | undefined {', '  return AXE_RULES[ruleId];', '}', ''].join(NL);

writeFileSync('engine/access/axe-rules.ts', `${head}${NL}${body}${NL}${tail}`, 'utf8');
console.log(`axe-core ${version}: wrote ${sorted.length} rules (${withCriterion} with a criterion) to engine/access/axe-rules.ts`);
