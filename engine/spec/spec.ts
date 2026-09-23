// Phase 14: writing for people. An epic, its stories and their acceptance criteria - written from
// the same facts the test plan is written from, and held to the same rule: anything Tewip says the
// system already does must be quoted from code or tests it actually read. A claim it cannot quote
// becomes an open question instead of a confident sentence.
//
// Refused on purpose (ROADMAP): business plans, market analysis, estimates, anything Tewip cannot
// check. A confident document nobody can verify is the opposite of what this project is for.
import type { LlmClient } from '../llm/client.ts';
import type { PlanFacts } from '../quality/plan.ts';

export const SPEC_PROMPT_VERSION = 'spec-1';

export interface AcceptanceCriterion {
  id: string;
  given: string;
  when: string;
  then: string;
}

export interface Story {
  id: string;
  /** "As a reader, I want ... so that ..." */
  title: string;
  why: string;
  priority: 'P0' | 'P1' | 'P2';
  acceptance_criteria: AcceptanceCriterion[];
  /** What the code or tests already do for this story, and the exact quote that shows it. */
  today: string;
  evidence: string;
}

export interface Spec {
  epic: { title: string; summary: string; problem: string; value: string; out_of_scope: string[] };
  stories: Story[];
  /** Claims about what the system already does, each with a quote Tewip checks. */
  already_true: Array<{ claim: string; evidence: string }>;
  open_questions: string[];
}

const SYSTEM = `You are Tewip's specification writer, a senior product engineer who works from the code.

Write an epic, its user stories, and acceptance criteria for the feature described. Use only the facts given: the feature description, the change, the pages of the running app, the tests that already exist, the source files read, and this project's failure history.

Rules:
- Every statement about what the system ALREADY does must be backed by a quote: evidence is a file path from the facts, then ": ", then a piece of that file copied character for character (a line of code, a test name, a comment). If you cannot quote it, do not claim it - put the uncertainty in open_questions.
- Acceptance criteria are Given / When / Then, each one checkable by a person or a test. No criterion may say "works correctly", "is fast" or "is user-friendly": say the observable thing.
- A story is one user-visible outcome, written as "As a <role>, I want <outcome> so that <benefit>". Split anything larger.
- Prefer what the failure history and the existing tests show is risky or already broken.
- Never write estimates, story points, dates, budgets, market claims or business cases. You cannot check those, so they do not belong here.
- out_of_scope is what this epic deliberately does not do. open_questions are the decisions a person must make.`;

const CRITERION = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'given', 'when', 'then'],
  properties: { id: { type: 'string' }, given: { type: 'string' }, when: { type: 'string' }, then: { type: 'string' } },
} as const;

const STORY = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'why', 'priority', 'acceptance_criteria', 'today', 'evidence'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    why: { type: 'string' },
    priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
    acceptance_criteria: { type: 'array', items: CRITERION },
    today: { type: 'string' },
    evidence: { type: 'string' },
  },
} as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['epic', 'stories', 'already_true', 'open_questions'],
  properties: {
    epic: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary', 'problem', 'value', 'out_of_scope'],
      properties: { title: { type: 'string' }, summary: { type: 'string' }, problem: { type: 'string' }, value: { type: 'string' }, out_of_scope: { type: 'array', items: { type: 'string' } } },
    },
    stories: { type: 'array', items: STORY },
    already_true: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['claim', 'evidence'], properties: { claim: { type: 'string' }, evidence: { type: 'string' } } },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
} as const;

function factsForModel(f: PlanFacts): string {
  return JSON.stringify({
    feature: f.feature,
    change: f.change ? { range: f.change.range, files: f.change.files, diff: f.change.patch } : 'no change given',
    pages: f.pages.length ? f.pages.map((p) => ({ url: p.url, title: p.title, accessibilitySnapshot: p.aria })) : f.pagesNote ?? 'no pages given',
    existingTests: { files: f.tests.files, names: f.tests.tests, relatedSources: f.testSources },
    code: f.codeSources?.length ? f.codeSources : 'not read',
    failureHistory: f.history.length ? f.history : 'none recorded yet',
  });
}

/** Everything Tewip read, as text to check a quote against. */
function readable(facts: PlanFacts): Array<{ file: string; content: string }> {
  return [...(facts.testSources ?? []), ...(facts.codeSources ?? [])].map((s) => ({ file: s.file, content: s.content }));
}

/**
 * A quote is real when the file is one Tewip read and the distinctive parts of the quote are in it.
 * Whitespace and quote style differ between a model's copy and the file, so the comparison is on
 * the words and symbols, not on the exact spacing.
 */
export function quoteHolds(evidence: string, sources: Array<{ file: string; content: string }>): boolean {
  const at = evidence.indexOf(': ');
  if (at < 0) return false;
  const file = evidence.slice(0, at).trim();
  const quote = evidence.slice(at + 2).trim();
  const source = sources.find((s) => s.file === file || s.file.endsWith(`/${file}`) || file.endsWith(s.file));
  if (!source || quote.length < 3) return false;
  const parts = quote.match(/[A-Za-z0-9_$.]{3,}/g) ?? [];
  if (parts.length === 0) return false;
  const body = source.content;
  // Every distinctive part must be in the file. Anything less lets a quote that is mostly real but
  // wrong where it matters through - "slice(0, 50)" and "slice(0, 10000)" differ by one word.
  return parts.every((part) => body.includes(part));
}

/**
 * Checks every claim about what already exists, and demotes the ones Tewip cannot quote into open
 * questions. This is the half of the phase metric Tewip can enforce itself: a spec that says "the
 * system already does X" when it does not is worse than a spec that asks.
 */
export function verifyClaims(spec: Spec, facts: PlanFacts): Spec {
  const sources = readable(facts);
  const questions = [...spec.open_questions];
  const kept: Spec['already_true'] = [];
  for (const claim of spec.already_true) {
    if (quoteHolds(claim.evidence, sources)) kept.push(claim);
    else questions.push(`Unverified: "${claim.claim}" - Tewip could not find that in the code or tests it read. Confirm before relying on it.`);
  }
  const stories = spec.stories.map((story) => {
    if (!story.today.trim() || quoteHolds(story.evidence, sources)) return story;
    questions.push(`Unverified, in ${story.id}: "${story.today}" - no quote in the code Tewip read supports it.`);
    return { ...story, today: '', evidence: '' };
  });
  return { ...spec, stories, already_true: kept, open_questions: questions };
}

export async function writeSpec(facts: PlanFacts, model: LlmClient): Promise<Spec> {
  const raw = await model.complete({ system: SYSTEM, user: factsForModel(facts), schemaName: 'tewip_spec', schema: SCHEMA });
  return verifyClaims(JSON.parse(raw) as Spec, facts);
}
