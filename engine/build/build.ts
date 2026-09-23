// Phase: writing feature code, at the owner's request (ROADMAP, 2026-09-23).
//
// The promise that replaces "it never touches application code" is harder and better: **it cannot
// change your code without showing you it works.** That is what this file's prompts are shaped
// around, and the order matters -
//
//   1. write the test for the feature first, and prove it FAILS, because a test that passes before
//      the feature exists is testing nothing;
//   2. write the smallest code that makes that test pass;
//   3. prove the test now passes and that nothing which was passing has started to fail.
//
// The model proposes. The test runner decides. Nothing here trusts a model's opinion of its own
// work, which is the only reason letting it write feature code is safe at all.
import type { LlmClient } from '../llm/client.ts';
import type { Framework } from '../quality/frameworks.ts';

export const BUILD_PROMPT_VERSION = 'build-1';

export interface FeatureTest {
  /** The whole test file. */
  code: string;
  /** One sentence naming the behaviour this test asserts. Not advice about where to put the file. */
  checks: string;
  /** Why this must fail today - the behaviour that does not exist yet. */
  failsBecause: string;
}

export interface FileEdit {
  file: string;
  /** For an existing file: the exact text to replace, appearing once. Empty for a new file. */
  before: string;
  /** The replacement, or the whole contents of a new file. */
  after: string;
}

export interface CodeChange {
  edits: FileEdit[];
  /** What was built, in one or two sentences a reviewer can check against the diff. */
  why: string;
  /** 'built' when code is offered; 'cannot' when the model will not guess. */
  outcome: 'built' | 'cannot';
}

const RULES = `Rules that do not bend:
- Use only what the project already has: its framework, its style, its helpers, its way of importing. Copy the shape of the example test and the example source given.
- Never weaken or delete an existing test, and never change what one asserts.
- Keep the change small and local. Add a file when the project's own layout calls for one; do not reorganise anything.
- Write no comments that restate the code, no logging, no defensive try/catch around things that cannot fail.
- before must be copied character for character from the file given and appear in it exactly once. For a new file, before is empty and after is the whole file.`;

const TEST_SYSTEM = `You are Tewip, writing the test for a feature that does not exist yet.

Write ONE test that checks the described behaviour, in the project's own framework and style. It must fail when run now, and fail for the right reason: the behaviour is missing, not because of a typo, a missing import or a file that does not exist. Use only functions, files and exports that already exist, or the one new export the feature obviously needs - name it as the project would.

checks is one sentence naming the behaviour the test asserts ("a full URL keeps its query when the trailing slash is removed"). It is not advice about file names or where to put things.
failsBecause is the behaviour that is missing today, in one sentence.

${RULES}`;

const CODE_SYSTEM = `You are Tewip, writing the code that makes a failing test pass.

You are given the feature, the test, the real error it produced, and the project's relevant source. Write the smallest change that makes that test pass because the behaviour now exists - never by weakening the test, never by special-casing the test's own values.

If the feature cannot be built from what you were given - the code you need is not here, or the request is ambiguous in a way that changes the answer - set outcome to "cannot" and return no edits. Saying "I cannot" is a correct answer; a guess that happens to pass one test is not.

${RULES}`;

const REPAIR_SYSTEM = `You are Tewip, fixing code you just wrote. The test still fails, or other tests broke. You are given what you changed and the real output.

Change your own code so the failing test passes and everything that was passing still passes. Never change the test. If you cannot, set outcome to "cannot".

${RULES}`;

const TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'checks', 'failsBecause'],
  properties: { code: { type: 'string' }, checks: { type: 'string' }, failsBecause: { type: 'string' } },
} as const;

const EDIT = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'before', 'after'],
  properties: { file: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } },
} as const;

const CODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'why', 'edits'],
  properties: { outcome: { type: 'string', enum: ['built', 'cannot'] }, why: { type: 'string' }, edits: { type: 'array', items: EDIT } },
} as const;

export interface BuildContext {
  feature: string;
  framework: Framework;
  /** An existing test to copy the style of. */
  exampleTest: string;
  /** The source files the feature most likely belongs in, with their contents. */
  sources: Array<{ file: string; content: string }>;
  /** What the project's tests are called and where they live. */
  testNames: string[];
}

export async function writeFeatureTest(model: LlmClient, ctx: BuildContext): Promise<FeatureTest> {
  const raw = await model.complete({
    system: TEST_SYSTEM,
    user: JSON.stringify({
      feature: ctx.feature,
      framework: ctx.framework.label,
      exampleTest: ctx.exampleTest.slice(0, 6000),
      existingTestNames: ctx.testNames.slice(0, 60),
      source: ctx.sources.map((s) => ({ file: s.file, content: s.content.slice(0, 6000) })),
    }),
    schemaName: 'tewip_feature_test',
    schema: TEST_SCHEMA,
  });
  return JSON.parse(raw) as FeatureTest;
}

export async function writeFeatureCode(model: LlmClient, ctx: BuildContext, test: { file: string; code: string }, error: string): Promise<CodeChange> {
  const raw = await model.complete({
    system: CODE_SYSTEM,
    user: JSON.stringify({
      feature: ctx.feature,
      test: { file: test.file, code: test.code.slice(0, 8000) },
      errorItProduced: error.slice(0, 4000),
      source: ctx.sources.map((s) => ({ file: s.file, content: s.content.slice(0, 12_000) })),
    }),
    schemaName: 'tewip_feature_code',
    schema: CODE_SCHEMA,
  });
  return JSON.parse(raw) as CodeChange;
}

export async function repairFeatureCode(model: LlmClient, ctx: BuildContext, attempt: { edits: FileEdit[]; output: string; broke: string[] }): Promise<CodeChange> {
  const raw = await model.complete({
    system: REPAIR_SYSTEM,
    user: JSON.stringify({
      feature: ctx.feature,
      whatYouChanged: attempt.edits.map((e) => ({ file: e.file, after: e.after.slice(0, 4000) })),
      output: attempt.output.slice(0, 4000),
      testsThatBroke: attempt.broke.slice(0, 10),
      source: ctx.sources.map((s) => ({ file: s.file, content: s.content.slice(0, 12_000) })),
    }),
    schemaName: 'tewip_feature_repair',
    schema: CODE_SCHEMA,
  });
  return JSON.parse(raw) as CodeChange;
}
