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
import { jsonFromModel } from '../llm/json-from-model.ts';

export const WRITE_PROMPT_VERSION = 'write-6';

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
  /** For an app fault: an exact quote from the real error or page showing what the app did. Checked. */
  observed: string;
}

const RULES = `Rules:
- Write in the given framework and language, in the style of the example test: the same imports, helpers, and way of opening pages (if it uses a base URL with relative paths, do the same).
- When houseRules is given, it is this team's own written guidance. Follow it as you would the example test; where it conflicts with your habits, the team wins.
- Find elements only by what the accessibility snapshots show: role and accessible name, label, placeholder or visible text. Never invent ids, classes or test ids that no snapshot shows.
- Check the scenario's expected result specifically. A check that is always true (a page merely loads, a list merely exists) is not a test.
- Wait for conditions, never for fixed times.
- Do not hard-code values that change as the app's content grows (counts, totals, dates, ids) unless the scenario is about that exact value: check their shape instead (a number of books, a date), so the test does not break the day a record is added.
- One test file, complete, runnable as is, no placeholders. It must actually run here: Tewip runs it against the app now, and a skipped test proves nothing. A guard like the example's (skip where the app lacks something) is fine, as long as it does not skip here.
- mutation.find must be an exact substring of your code that appears once, inside the main assertion (the value or condition it expects); mutation.replace is what to put there instead so that the test must fail if it is a real check. Keep the code valid: change an expected value, not the syntax.
- To import something from codeUnderTest, use that entry's importPath exactly as given. It is already relative to the folder the test will be written in (testWillBeWrittenIn); its \`file\` is relative to the project root and is there to tell you where the code lives, not how to import it.`;

const DRAFT_SYSTEM = `You are Tewip's test writer, a senior SDET. Write one automated test for the scenario given.\n\n${RULES}`;

const REPAIR_SYSTEM = `You are Tewip's test writer, a senior SDET. Your test failed when run against the working app. Read the real error and decide:
- fault "test": the test is wrong (a locator, a wait, a wrong assumption about the page). Return the corrected full test.
- fault "app": the test is right and the app does not do what the scenario expects. Return the test unchanged, say in reason what the app did instead, and put in observed an exact quote (copied character for character) from the real error or the page snapshot that shows it. Without such a quote, it is not an app fault. For fault "test", observed is empty.
If the code documents the behaviour the app showed (a comment or doc saying so), the scenario's expectation was wrong: the fault is "test"; correct the check to the documented behaviour and say so in reason.
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
  required: ['fault', 'reason', 'observed', 'code', 'checks', 'mutation'],
  properties: { fault: { type: 'string', enum: ['test', 'app'] }, reason: { type: 'string' }, observed: { type: 'string' }, ...DRAFT_PROPS },
} as const;

export interface WriteContext {
  framework: Framework;
  fileName: string;
  pages: PageFacts[];
  feature: string;
  /**
   * The source files the feature lives in, so a failing check can be weighed against documented
   * intent - each with the path to import it by **from where the test will be written**.
   *
   * `file` alone is project-relative, and the model was given nothing else. For a framework whose
   * test folder is not the project root, every generated import was wrong: a test written into
   * `engine/test/` importing `../engine/access/render.ts` resolves to `engine/engine/access/...`,
   * which does not exist, so the file would not load and `incident` reported "the test never ran -
   * something was missing or would not compile" about a test that was otherwise correct. Measured on
   * a real stack trace from this repository.
   */
  code?: Array<{ file: string; content: string; importPath?: string }>;
  /** Where the test will be written, relative to the project root, so an import can be relative to it. */
  testDir?: string;
  /**
   * The team's own guidance from `.tewip/standards/`, for the parts of house style no pattern can check.
   * A test written in the project's own conventions is one somebody will keep; one written in Tewip's
   * conventions is one they rewrite, and then stop asking for.
   */
  houseRules?: string;
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
    codeUnderTest: ctx.code?.length ? ctx.code : undefined,
    // Where the test file itself will sit, so a relative import can be written correctly rather
    // than guessed from a project-relative path.
    testWillBeWrittenIn: ctx.testDir || undefined,
    houseRules: ctx.houseRules || undefined,
  };
}

export async function draftTest(model: LlmClient, ctx: WriteContext, scenario: Scenario): Promise<Draft> {
  const raw = await model.complete({ system: DRAFT_SYSTEM, user: JSON.stringify(contextFor(ctx, scenario)), schemaName: 'tewip_test_draft', schema: DRAFT_SCHEMA });
  return jsonFromModel<Draft>(raw);
}

/** The first lines of a failure: which check failed and how, without the page or the call log. */
export function failureHead(error: string): string {
  const start = error.search(/\b(?:\w*Error|FAILED|AssertionError|Exception)\b/);
  return error.slice(Math.max(0, start)).split(/\n\s*(?:Call log:|at |The page when)/)[0].trim().slice(0, 800);
}

export async function repairTest(model: LlmClient, ctx: WriteContext, scenario: Scenario, draft: Draft, error: string, earlier: string[] = []): Promise<Repair> {
  // A check that keeps failing the same way after repairs is what the app consistently does: say so,
  // so the model weighs "the app is wrong" instead of reshaping the test around the app.
  const repeated = earlier.length > 0 ? { earlierFailures: earlier, note: 'Your earlier repairs failed too. If the same check keeps failing because the page does something other than the scenario expects, the fault is "app".' } : {};
  const user = JSON.stringify({ ...contextFor(ctx, scenario), yourTest: draft.code, realError: error.slice(-10000), ...repeated });
  const raw = await model.complete({ system: REPAIR_SYSTEM, user, schemaName: 'tewip_test_repair', schema: REPAIR_SCHEMA });
  return jsonFromModel<Repair>(raw);
}

/**
 * The broken-on-purpose version of a test, or why none could be made. The piece to change must
 * occur exactly once, sit on a line that checks something, and actually change it.
 */
export function mutate(draft: Draft): { code: string } | { problem: string } {
  const { find, replace } = draft.mutation;
  if (!find || find === replace) return { problem: 'the mutation changes nothing' };
  const lineAt = (at: number) => {
    const end = draft.code.indexOf('\n', at);
    return draft.code.slice(draft.code.lastIndexOf('\n', at) + 1, end < 0 ? undefined : end);
  };
  const places: number[] = [];
  for (let at = draft.code.indexOf(find); at >= 0; at = draft.code.indexOf(find, at + 1)) places.push(at);
  if (places.length === 0) return { problem: `the piece to change ("${find.slice(0, 60)}") is not in the test` };
  // Several places: fine when exactly one of them is in a check (the same value is often both the
  // input and the expected result).
  // A check may span lines (a multi-line expect, or `out:` above the expected value), so the two
  // lines before the piece count too.
  const withContext = (at: number) => {
    const start = draft.code.lastIndexOf('\n', at);
    const before = draft.code.slice(0, Math.max(0, start)).split('\n').slice(-2).join('\n');
    return `${before}\n${lineAt(at)}`;
  };
  const inChecks = places.filter((at) => CHECK_LINE.test(withContext(at)));
  if (inChecks.length !== 1) {
    return { problem: inChecks.length === 0 ? `the piece to change is not in a check: ${lineAt(places[0]).trim().slice(0, 100)}` : `the piece to change ("${find.slice(0, 60)}") is in ${inChecks.length} checks; pick one exact place` };
  }
  const at = inChecks[0];
  return { code: draft.code.slice(0, at) + replace + draft.code.slice(at + find.length) };
}

/** A line that checks a result: an assertion, or the expected column of a table-driven test. */
const CHECK_LINE = /expect|assert|should|verify|Assert|toHave|toBe|toEqual|toContain|toMatch|contains|Equal|raises|Raises|Throws|toThrow|[=!]==?|\b(?:out|output|expected|want|result)\s*[:=]/;

const MUTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mutation'],
  properties: { mutation: DRAFT_PROPS.mutation },
} as const;

/** One more try at a usable deliberate break, when the first could not be applied. */
export async function remutate(model: LlmClient, draft: Draft, problem: string): Promise<Draft> {
  const user = JSON.stringify({ test: draft.code, yourMutation: draft.mutation, problem });
  const system = 'You chose a deliberate break for this test so Tewip can prove it can fail, but it could not be applied. Choose again: mutation.find must be an exact substring of the test, inside the main check (an assertion, or the expected value in a table of cases), appearing exactly once inside a check; mutation.replace must make a correct test fail while keeping the code valid.';
  const raw = await model.complete({ system, user, schemaName: 'tewip_mutation', schema: MUTATION_SCHEMA });
  return { ...draft, mutation: (JSON.parse(raw) as { mutation: Draft['mutation'] }).mutation };
}

/**
 * Checks that may break when the app's data changes rather than when it breaks: a number of three
 * or more digits written into an expected text or value. Shown to the reviewer, not a reason to drop
 * the test, since some scenarios are about an exact figure.
 */
export function brittleChecks(code: string): string[] {
  return code
    .split('\n')
    .filter((line) => /expect|assert|should|Assert/.test(line) && /(['"`])[^'"`\n]*\b\d{3,}\b[^'"`\n]*\1/.test(line) && !/timeout|status|toBeLessThan|toBeGreaterThan/i.test(line))
    .map((line) => line.trim().slice(0, 140));
}

/** Lines that check something: an assertion, or an expected value in a table of cases. */
const checkLines = (code: string) => code.split('\n').filter((line) => /expect|assert|should|Assert|verify/.test(line) && !/^\s*(?:\/\/|\*|#)/.test(line));

/** A check that can only say something is absent: it passes as long as the thing never appears. */
const NEGATIVE = /\.not[.\s(]|not\.to|toBeNull|toBeUndefined|toBeFalsy|assertFalse|assertNull|toHaveLength\(0\)|isNull|isFalse|\bnot_/;
/** A check that is true of almost any value: it proves the code ran, not that it is right. */
const SHALLOW = /toBeDefined\(\)|toBeTruthy\(\)|not\.toBeNull\(\)|toBeInstanceOf\(|typeof\s|assertIsNotNone|is not None|toBeGreaterThanOrEqual\(0\)/;

/**
 * Checks worth a second look, though the test passes and fails when broken: a test whose every
 * check only says something is absent, or only that a value exists, can keep passing while the
 * behaviour it is named for disappears. The deliberate break cannot see this, because it changes
 * one check and that check does fail.
 */
export function weakChecks(code: string): string | null {
  const lines = checkLines(code);
  if (lines.length === 0) return null;
  if (lines.every((l) => NEGATIVE.test(l))) return `every check only says something is absent (${lines.length} check(s)), so it passes while the feature is missing`;
  if (lines.every((l) => SHALLOW.test(l))) return `every check only says a value exists (${lines.length} check(s)), not that it is right`;
  return null;
}
