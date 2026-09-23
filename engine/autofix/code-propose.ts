// Phase 12: asking for a change to application code, in the only shape Tewip will accept - an exact
// piece of the file and what to put instead. A whole-file rewrite would hide what changed; a diff
// the model invents may not apply. One exact replacement can be checked before it is used: it must
// appear in the file exactly once, and the result is compared line by line against the original.
//
// Nothing here decides whether a change is right. The failing test decides that, afterwards.
import type { LlmClient } from '../llm/client.ts';

export const CODE_FIX_PROMPT_VERSION = 'code-fix-1';

export interface CodeChange {
  /** An exact substring of the file, appearing exactly once. */
  before: string;
  /** What to put there instead. */
  after: string;
  /** What the bug was, in one or two sentences a reviewer can check against the diff. */
  why: string;
  /** The model's own reading: 'bug' when the code is wrong, 'test' when the test looks wrong. */
  fault: 'bug' | 'test';
}

const SYSTEM = `You are Tewip's fixer. A test is failing against this code. Find the smallest change to the APPLICATION code that makes the test pass because the bug is gone, not because the check was avoided.

Rules:
- Change application code only. Never suggest changing the test, the expected values in it, configuration, or anything that silences the failure.
- The change must be minimal and local: the fewest lines that fix the cause. Do not refactor, rename, reformat, add logging, or "improve" anything nearby.
- before must be copied character for character from the file you were given, including indentation, and must appear in it exactly once. Include enough surrounding lines to be unique. Copy only what is in the file: nothing is added to it, so do not add line numbers or markers.
- after must keep the file valid in its language and keep the behaviour every other test relies on.
- If the code is right and the test is wrong, or if you cannot see the cause in the file you were given, set fault to "test" and return before and after as empty strings. Saying "I cannot see it" is a correct answer; a guess is not.
- why is for a reviewer: what was wrong and why this fixes it.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fault', 'why', 'before', 'after'],
  properties: {
    fault: { type: 'string', enum: ['bug', 'test'] },
    why: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
  },
} as const;

export interface FixContext {
  /** The failing test's name and the error it printed. */
  testId: string;
  error: string;
  /** The test's own source, so the model can see what is being asked of the code. */
  testSource: string;
  /** Path of the application file, relative to the project. */
  file: string;
  /** The file's source, exactly as it is on disk, trimmed around the failing line when it is long. */
  source: string;
  /** Which line the failure pointed at, since the source carries no line numbers to copy by mistake. */
  line?: number;
  /** What an earlier attempt tried and what happened, so the next one does not repeat it. */
  earlier: string[];
}

export async function proposeCodeFix(model: LlmClient, ctx: FixContext): Promise<CodeChange> {
  const raw = await model.complete({ system: SYSTEM, user: JSON.stringify(ctx), schemaName: 'tewip_code_fix', schema: SCHEMA });
  return JSON.parse(raw) as CodeChange;
}

/**
 * The file as it is on disk, kept around the failing line when it is too long to send whole.
 *
 * Deliberately without line numbers. An earlier version numbered every line, and in a measurement
 * against real bug fixes the model copied text that still carried those numbers: the change matched
 * nothing in the file and was thrown away for a reason that was Tewip's fault, not the model's.
 */
export function excerpt(source: string, around = 1, maxLines = 900): { text: string; from: number } {
  const lines = source.split('\n');
  if (lines.length <= maxLines) return { text: source, from: 1 };
  const from = Math.max(0, around - Math.floor(maxLines / 2));
  return { text: lines.slice(from, Math.min(lines.length, from + maxLines)).join('\n'), from: from + 1 };
}
