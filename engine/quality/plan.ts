// Phase 6: test plans. Tewip writes a plan from facts it reads, not from imagination: the feature
// as described, what a change touched, the pages of the running app, the tests that already exist,
// and - what general agents do not have - the project's own failure history, so the plan weighs
// the areas that broke or flaked before. The model proposes; everything it may rely on is listed
// with the plan, and scenarios say what they are grounded on.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmClient } from '../llm/client.ts';
import { readJsonl } from '../../reporters/store.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { changeSummary, existingTests, readPages, type ChangeSummary, type ExistingTests, type PageFacts } from './grounding.ts';

export const PLAN_PROMPT_VERSION = 'plan-2';

export interface PlanInput {
  feature: string;
  root: string;
  diffRange?: string;
  urls?: string[];
}

export interface PlanFacts {
  feature: string;
  change: ChangeSummary | null;
  pages: PageFacts[];
  pagesNote: string | null;
  tests: ExistingTests;
  /** Tests that failed before in this project, with what Tewip decided they were. */
  history: string[];
}

/** Failures Tewip already diagnosed in this project (from `tewip explain` runs kept in .tewip). */
function failureHistory(root: string, cap = 60): string[] {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return [];
  const seen = new Map<string, string>();
  for (const project of readdirSync(dir)) {
    for (const r of readJsonl<TriageRecord & { diagnosis?: { category: string } }>(join(dir, project, 'triage.jsonl'))) {
      seen.set(r.testId, r.diagnosis?.category ?? 'UNKNOWN');
    }
  }
  return [...seen].slice(-cap).map(([test, category]) => `${test}: ${category}`);
}

export async function gatherPlanFacts(input: PlanInput): Promise<PlanFacts> {
  const { pages, note } = await readPages(input.urls ?? []);
  return {
    feature: input.feature,
    change: input.diffRange ? changeSummary(input.root, input.diffRange) : null,
    pages,
    pagesNote: note,
    tests: existingTests(input.root),
    history: failureHistory(input.root),
  };
}

const SYSTEM = `You are Tewip's test planner, a senior QA lead. Write a test plan for the feature described.

Use only the facts given: the feature description, the change (files and diff), the pages of the running app (accessibility snapshots: the roles and names a user sees), the tests that already exist, and the project's failure history.
- Name page elements only as they appear in a snapshot. If a scenario needs something no snapshot shows, say so in grounded_on ("not seen on the pages read; confirm").
- Do not plan what an existing test already covers. covered_by is either an entry copied exactly from existingTests.names that fully covers the scenario, or an empty string. Partial or related coverage goes in grounded_on, never in covered_by.
- Weigh the failure history: an area whose tests failed or flaked before deserves a scenario for that risk.
- Cover more than the happy path: negative cases, boundaries, accessibility, and security where the feature touches input, access or data.
- Prioritise: P0 breaks the feature for everyone, P1 breaks it for some or corrupts data, P2 is a lesser problem.
- Keep steps concrete and short, as a tester would run them. Mark automate true when a stable automated check is realistic.`;

const SCENARIO = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'type', 'priority', 'preconditions', 'steps', 'expected', 'automate', 'covered_by', 'grounded_on'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    type: { type: 'string', enum: ['functional', 'negative', 'boundary', 'accessibility', 'security', 'performance', 'compatibility'] },
    priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
    preconditions: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    expected: { type: 'string' },
    automate: { type: 'boolean' },
    covered_by: { type: 'string' },
    grounded_on: { type: 'string' },
  },
} as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'scope', 'out_of_scope', 'risks', 'scenarios', 'open_questions'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    scope: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
    risks: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['risk', 'why', 'severity'], properties: { risk: { type: 'string' }, why: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] } } },
    },
    scenarios: { type: 'array', items: SCENARIO },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface Plan {
  title: string;
  summary: string;
  scope: string[];
  out_of_scope: string[];
  risks: Array<{ risk: string; why: string; severity: 'high' | 'medium' | 'low' }>;
  scenarios: Array<{ id: string; title: string; type: string; priority: 'P0' | 'P1' | 'P2'; preconditions: string; steps: string[]; expected: string; automate: boolean; covered_by: string; grounded_on: string }>;
  open_questions: string[];
}

function factsForModel(f: PlanFacts): string {
  return JSON.stringify({
    feature: f.feature,
    change: f.change ? { range: f.change.range, files: f.change.files, diff: f.change.patch } : 'no change given',
    pages: f.pages.length ? f.pages.map((p) => ({ url: p.url, title: p.title, accessibilitySnapshot: p.aria })) : f.pagesNote ?? 'no pages given',
    existingTests: { files: f.tests.files, names: f.tests.tests },
    failureHistory: f.history.length ? f.history : 'none recorded yet',
  });
}

/**
 * The model's "already covered by" claims are checked against the tests Tewip actually found: a
 * claim naming no real test is dropped (and kept as context in grounded_on), so a scenario is never
 * marked covered, and left out of what to automate, on the model's word alone.
 */
export function verifyCoverage(plan: Plan, facts: PlanFacts): Plan {
  const known = new Set(facts.tests.tests);
  return {
    ...plan,
    scenarios: plan.scenarios.map((s) => {
      const claim = s.covered_by.trim();
      if (!claim || known.has(claim)) return { ...s, covered_by: claim };
      return { ...s, covered_by: '', grounded_on: `${s.grounded_on} (related, not a full cover: ${claim})` };
    }),
  };
}

export async function writePlan(facts: PlanFacts, model: LlmClient): Promise<Plan> {
  const raw = await model.complete({ system: SYSTEM, user: factsForModel(facts), schemaName: 'tewip_test_plan', schema: SCHEMA });
  return verifyCoverage(JSON.parse(raw) as Plan, facts);
}
