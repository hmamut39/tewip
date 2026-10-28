// Phase 14: writing for people. The whole point of this phase is the check, not the prose - a
// specification that says "the system already does X" when it does not is worse than one that asks.
// These tests are about that check, and about the things Tewip refuses to write.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlanFacts } from '../quality/plan.ts';
import { quoteHolds, verifyClaims, type Spec } from '../spec/spec.ts';
import { renderSpec, storyBody } from '../spec/spec-render.ts';

const NL = String.fromCharCode(10);

const FACTS = {
  feature: 'Library search',
  change: null,
  pages: [],
  pagesNote: null,
  tests: { files: ['tests/search.spec.ts'], tests: ['finds a word'] },
  testSources: [{ file: 'tests/search.spec.ts', content: ['test("finds a word", async ({ page }) => {', '  await expect(page.getByRole("listitem")).toHaveCount(3);', '});'].join(NL) }],
  codeSources: [{ file: 'src/search.ts', content: ['export function search(term: string) {', '  // results are capped at 50', '  return index.lookup(term).slice(0, 50);', '}'].join(NL) }],
  history: [],
} as unknown as PlanFacts;

const story = (over: Partial<Spec['stories'][number]> = {}): Spec['stories'][number] => ({
  id: 'LS-1',
  title: 'As a reader, I want to search the library so that I can find a passage',
  why: 'Readers cannot find anything today',
  priority: 'P1',
  acceptance_criteria: [{ id: 'AC-1', given: 'the library has books', when: 'a reader searches for a word', then: 'matching passages are listed' }],
  today: '',
  evidence: '',
  ...over,
});

const spec = (over: Partial<Spec> = {}): Spec => ({
  epic: { title: 'Library search', summary: 'Let readers find passages.', problem: 'No way to search.', value: 'Readers find what they need.', out_of_scope: ['ranking'] },
  stories: [story()],
  already_true: [],
  open_questions: [],
  ...over,
});

describe('checking what a specification claims already exists', () => {
  it('accepts a quote that is really in a file Tewip read', () => {
    assert.equal(quoteHolds('src/search.ts: return index.lookup(term).slice(0, 50);', FACTS.codeSources!), true);
    assert.equal(quoteHolds('src/search.ts: results are capped at 50', FACTS.codeSources!), true, 'a comment counts: it is in the file');
  });

  it('refuses a quote from a file it never read, and one that is not in the file', () => {
    assert.equal(quoteHolds('src/nowhere.ts: something', FACTS.codeSources!), false);
    assert.equal(quoteHolds('src/search.ts: return index.lookup(term).slice(0, 10000);', FACTS.codeSources!), false);
    assert.equal(quoteHolds('no file named here', FACTS.codeSources!), false);
  });

  it('turns a claim it cannot quote into an open question instead of a confident sentence', () => {
    const checked = verifyClaims(
      spec({
        already_true: [
          { claim: 'Search results are capped at fifty.', evidence: 'src/search.ts: results are capped at 50' },
          { claim: 'Search is case-insensitive.', evidence: 'src/search.ts: term.toLowerCase()' },
        ],
      }),
      FACTS,
    );
    assert.deepEqual(checked.already_true.map((c) => c.claim), ['Search results are capped at fifty.']);
    assert.equal(checked.open_questions.length, 1);
    assert.match(checked.open_questions[0], /Unverified: "Search is case-insensitive\."/);
  });

  it('strips an unproved "today" from a story, keeping the story itself', () => {
    const checked = verifyClaims(spec({ stories: [story({ today: 'Search already ranks by relevance.', evidence: 'src/search.ts: rankByRelevance(results)' })] }), FACTS);
    assert.equal(checked.stories[0].today, '', 'the claim goes, the story stays');
    assert.equal(checked.stories[0].acceptance_criteria.length, 1);
    assert.match(checked.open_questions.join(NL), /Unverified, in LS-1/);
  });
});

describe('what the specification looks like', () => {
  it('reads as an epic with stories, criteria and its own limits', () => {
    const text = renderSpec(spec({ already_true: [{ claim: 'Results are capped at 50.', evidence: 'src/search.ts: slice(0, 50)' }], open_questions: ['Which languages must be searchable?'] }));
    assert.match(text, /^# Library search/);
    assert.match(text, /### LS-1 · As a reader/);
    assert.match(text, /Given the library has books; when a reader searches for a word; then matching passages are listed/);
    assert.match(text, /## What the code already does/);
    assert.match(text, /## Open questions/);
    assert.match(text, /no estimates,/, 'it says plainly what it does not contain');
  });

  it('writes a story a person can hand over', () => {
    const body = storyBody(story({ today: 'Nothing exists yet.', evidence: 'src/search.ts: export function search' }));
    assert.match(body, /Acceptance criteria:/);
    assert.match(body, /Given the library has books/);
    assert.match(body, /review before you rely on it/);
  });
});

// Phase 78: field-tested on a real project. The command's claim - "anything it says the system
// already does is quoted from a file it read" - held on the real run: all four quotes it produced
// were in the file character for character, checked by hand.
//
// The checker that guarantees that did not hold. It collected the quote's "distinctive parts", runs
// of [A-Za-z0-9_$.]{3,}, and required each to appear somewhere in the file in any order.
describe('a quote that is mostly real and wrong where it matters', () => {
  const CART = [
    'export function discount(items, percent) {',
    '  const rate = Math.min(percent, 100) / 100;',
    '  return subtotal(items) * rate;',
    '}',
    'export function deliveryFee(items) {',
    '  return subtotal(items) >= 50 ? 0 : 4.99;',
    '}',
  ].join(NL);
  const sources = [{ file: 'src/cart.js', content: CART }];

  it('refuses a number swapped for another, which is the whole meaning of the line', () => {
    // Offered as evidence that a 20% cap is enforced, against a file whose cap is 100. Every part of
    // it is in the file - const, rate, Math.min, percent, 100 - and `20` is not a part at all,
    // because the pattern could not see a two-character number. The one token carrying the entire
    // meaning was the one token not checked.
    assert.equal(quoteHolds('src/cart.js: const rate = Math.min(percent, 20) / 100;', sources), false);
    assert.equal(quoteHolds('src/cart.js: const rate = Math.min(percent, 100) / 100;', sources), true, 'the real line still holds');
  });

  it('refuses a threshold swapped for another', () => {
    assert.equal(quoteHolds('src/cart.js: return subtotal(items) >= 75 ? 0 : 4.99;', sources), false);
    assert.equal(quoteHolds('src/cart.js: return subtotal(items) >= 50 ? 0 : 4.99;', sources), true);
  });

  it('refuses a line assembled from words the file really contains', () => {
    // Every word here is in the file; this arrangement of them never was.
    assert.equal(quoteHolds('src/cart.js: return discount(items, percent) - subtotal(items);', sources), false);
  });

  it('refuses a function that does not exist, however plausible', () => {
    assert.equal(quoteHolds('src/cart.js: export function loyaltyDiscount(items) {', sources), false);
  });

  it('still forgives the two differences that carry no meaning', () => {
    // A model copies a line with different indentation and different quote characters; neither
    // changes what the line says, and refusing those would demote true claims into questions.
    assert.equal(quoteHolds('src/cart.js:      const rate   =  Math.min(percent, 100) / 100;', sources), true, 'whitespace');
    const quoted = [{ file: 'src/a.js', content: "const greeting = 'hello';" }];
    assert.equal(quoteHolds('src/a.js: const greeting = "hello";', quoted), true, 'quote characters');
  });
});

// Phase 116: measured on 14 strangers' repositories rather than on three cases found by hand.
//
// 852 real lines pulled out of real source in ten languages, and 2,268 fabrications built from
// them the four ways a model misquotes a line it is looking straight at - one digit changed, one
// identifier swapped, two real lines welded, the words reordered. Every real line is accepted and
// not one fabrication gets through. Run the same measurement against the logic this replaced and
// 1,544 of the 2,268 (68.1%) are accepted, and 6 of the real lines are refused: the contiguous
// match is better in both directions, which was believed and had never been shown.
//
// See eval/spec-quotes.ts. The one case below is the only surprise the corpus turned up, and it
// is written down here because it is deliberate and looks like a bug.
describe('what the corpus measurement pinned down', () => {
  // Verbatim from dispatch/tests/factories.py, which is where this surfaced.
  const PY = ['import uuid', 'from datetime import datetime', '', 'from factory import (', '    LazyAttribute,', ')'].join(NL);
  const sources = [{ file: 'tests/factories.py', content: PY }];

  it('accepts a quote that spans two lines, because that is a real quote', () => {
    assert.equal(quoteHolds('tests/factories.py: from datetime import datetime from factory import (', sources), true);
  });

  it('and so accepts a fragment across the line break, which is the price of that', () => {
    // "datetime import datetime from" is not a statement, but it is text that is in the file, and
    // the normalisation that lets an honest two-line quote through lets this through too. Do not
    // "fix" it by forbidding the line break: that would refuse every multi-line quote, and no
    // model has ever been seen to produce a fragment like this. It is recorded, not defended.
    assert.equal(quoteHolds('tests/factories.py: datetime import datetime from', sources), true);
  });

  it('still refuses words of the file in an order the file never had', () => {
    assert.equal(quoteHolds('tests/factories.py: datetime from import uuid datetime', sources), false);
  });
});
