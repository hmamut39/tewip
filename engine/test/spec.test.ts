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
