// Phase 7: the model's side of `tewip write`. It drafts one test for one plan scenario, in the
// project's own framework and style, using only elements seen on the real page, and names one
// deliberate break of its main check (the mutation) so Tewip can prove the test is able to fail.
// When a draft fails, the model repairs it from the real error - or says the app looks wrong,
// because weakening a test until it passes would hide exactly the bug it exists to catch.
import { readFileSync } from 'node:fs';
import type { LlmClient } from '../llm/client.ts';
import type { Framework } from './frameworks.ts';
import type { PageFacts } from './grounding.ts';
import type { Plan } from './plan.ts';

export const WRITE_PROMPT_VERSION = 'write-2';

export type Scenario = Plan['scenarios'][number];

export interface Draft {
  code: string;
  /** In a sentence: what the test checks, for the report. */
  checks: string;
  /** One exact piece of the code, inside the main assertion, and what to put instead so a correct test must fail. */
  mutation: { find: string; replace: string };
}

export interface Repair extends Draft {
  /** "test" when the draft was wrong; "app" when the page does not do what the scenario expects. */
  fault: 'test' | 'app';
  reason: string;
}

const RULES = `Rules:
- Write in the given framework and language, in the style of the example test: the same imports, helpers, and way of opening pages (if it uses a base URL with relative paths, do the same).
- Find elements only by what the accessibility snapshots show: role and accessible name, label, placeholder or visible text. Never invent ids, classes or test ids that no snapshot shows.
- Check the scenario's expected result specifically. A check that is always true (a page merely loads, a list merely exists) is not a test.
- Wait for conditions, never for fixed times.
- One test file, complete, runnable as is, no placeholders. It must actually run here: Tewip runs it against the app now, and a skipped test proves nothing. A guard like the example's (skip where the app lacks something) is fine, as long as it does not skip here.
- mutation.find must be an exact substring of your code that appears once, inside the main assertion (the value or condition it expects); mutation.replace is what to put there instead so that the test must fail if it is a real check. Keep the code valid: change an expected value, not the syntax.`;

const DRAFT_SYSTEM = `You are Tewip's test writer, a senior SDET. Write one automated test for the scenario given.\n\n${RULES}`;

const REPAIR_SYSTEM = `You are Tewip's test writer, a senior SDET. Your test failed when run against the working app. Read the real error and decide:
- fault "test": the test is wrong (a locator, a wait, a wrong assumption about the page). Return the corrected full test.
- fault "app": the test is right and the app does not do what the scenario expects. Return the test unchanged and say in reason what the app did instead.
Never weaken the check of the scenario's expected result to make it pass: that would hide the bug the test exists to catch. If the only way to pass is to stop checking the expected result, the fault is "app".\n\n${RULES}`;

const DRAFT_PROPS = {
  code: { type: 'string' },
  checks: { type: 'string' },
  mutation: { type: 'object', additionalProperties: false, required: ['find', 'replace'], properties: { find: { type: 'string' }, replace: { type: 'string' } } },
} as const;

const DRAFT_SCHEMA = { type: 'object', additionalProperties: false, required: ['code', 'checks', 'mutation'], properties: DRAFT_PROPS } as const;
const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fault', 'reason', 'code', 'checks', 'mutation'],
  properties: { fault: { type: 'string', enum: ['test', 'app'] }, reason: { type: 'string' }, ...DRAFT_PROPS },
} as const;

export interface WriteContext {
  framework: Framework;
  fileName: string;
  pages: PageFacts[];
  feature: string;
}

function contextFor(ctx: WriteContext, scenario: Scenario) {
  const example = ctx.framework.example ? readFileSync(ctx.framework.example, 'utf8').slice(0, 6000) : 'none: write in the framework\'s usual style';
  return {
    framework: ctx.framework.label,
    fileName: ctx.fileName,
    note: /\.(java|kt|cs)$/.test(ctx.fileName) ? `the class must be named ${ctx.fileName.replace(/\.\w+$/, '')}` : undefined,
    feature: ctx.feature,
    scenario: { id: scenario.id, title: scenario.title, given: scenario.preconditions, steps: scenario.steps, expected: scenario.expected },
    exampleTest: example,
    pages: ctx.pages.map((p) => ({ readAt: p.url, title: p.title, accessibilitySnapshot: p.aria })),
  };
}

export async function draftTest(model: LlmClient, ctx: WriteContext, scenario: Scenario): Promise<Draft> {
  const raw = await model.complete({ system: DRAFT_SYSTEM, user: JSON.stringify(contextFor(ctx, scenario)), schemaName: 'tewip_test_draft', schema: DRAFT_SCHEMA });
  return JSON.parse(raw) as Draft;
}

export async function repairTest(model: LlmClient, ctx: WriteContext, scenario: Scenario, draft: Draft, error: string): Promise<Repair> {
  const user = JSON.stringify({ ...contextFor(ctx, scenario), yourTest: draft.code, realError: error.slice(-10000) });
  const raw = await model.complete({ system: REPAIR_SYSTEM, user, schemaName: 'tewip_test_repair', schema: REPAIR_SCHEMA });
  return JSON.parse(raw) as Repair;
}

/**
 * The broken-on-purpose version of a test, or why none could be made. The piece to change must
 * occur exactly once, sit on a line that checks something, and actually change it.
 */
export function mutate(draft: Draft): { code: string } | { problem: string } {
  const { find, replace } = draft.mutation;
  if (!find || find === replace) return { problem: 'the mutation changes nothing' };
  const at = draft.code.indexOf(find);
  if (at < 0 || draft.code.indexOf(find, at + 1) >= 0) return { problem: `the piece to change ("${find.slice(0, 60)}") does not appear exactly once` };
  const end = draft.code.indexOf('\n', at);
  const line = draft.code.slice(draft.code.lastIndexOf('\n', at) + 1, end < 0 ? undefined : end);
  if (!/expect|assert|should|verify|Assert|toHave|toBe|toEqual|toContain|toMatch|contains|Equal/.test(line)) return { problem: `the piece to change is not in a check: ${line.trim().slice(0, 100)}` };
  return { code: draft.code.slice(0, at) + replace + draft.code.slice(at + find.length) };
}
