// Phase-3 step for one failure the rules left UNKNOWN: ask the model, validate its answer
// against the fixed taxonomy, and return a diagnosis. Any failure keeps the rules' UNKNOWN.
import { recordFailure } from './usage.ts';
import { ROOT_CAUSES, type Diagnosis, type RootCause } from '../../reporters/types.ts';
import { truncate } from '../signature.ts';
import type { LlmClient } from './client.ts';
import type { FailureContext } from './context.ts';
import { OUTPUT_SCHEMA, OUTPUT_SCHEMA_NAME, PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';
import { jsonFromModel } from './json-from-model.ts';

export interface LlmOutput {
  category: RootCause;
  confidence: number;
  reasoning: string;
  evidence: string[];
}

/** Validates the model's JSON. Throws on anything outside the contract. */
export function parseLlmOutput(raw: string): LlmOutput {
  const value = jsonFromModel<Partial<LlmOutput>>(raw);
  if (!ROOT_CAUSES.includes(value.category as RootCause)) throw new Error(`category outside the taxonomy: ${String(value.category)}`);
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) throw new Error('confidence is not a number');
  if (typeof value.reasoning !== 'string') throw new Error('reasoning is not a string');
  if (!Array.isArray(value.evidence) || !value.evidence.every((e) => typeof e === 'string')) throw new Error('evidence is not a string list');
  return {
    category: value.category as RootCause,
    confidence: Math.round(Math.min(1, Math.max(0, value.confidence)) * 100) / 100,
    reasoning: truncate(value.reasoning, 600),
    evidence: value.evidence.slice(0, 4).map((e) => truncate(e, 300)),
  };
}

/**
 * A verdict the run history already rules out, whatever the model says.
 *
 * The prompt has told the model since llm-6 that a failure which passed on another attempt of the
 * same code cannot be a real bug or a drifted locator - both of those fail every time. Measured
 * against 547 real labelled CI failures from WordPress/gutenberg, it does not obey: the model layer
 * decided 87 of them and got **9 right**, and almost every miss was a flaky timing failure called
 * REAL_BUG or LOCATOR_DRIFT at a confidence of 0.9 or higher.
 *
 * Telling a team to hunt a bug that is not there is the most expensive mistake this tool can make,
 * and an instruction in a prompt is a request, not a guarantee. The same fact is checked here in
 * code, where it holds.
 *
 * It refuses rather than rewrites. "This cannot be REAL_BUG" is not "this is TIMING" - ENV and
 * TEST_DATA both survive a retry too - so the answer becomes UNKNOWN, which routes the failure to a
 * person with the model's reasoning attached rather than replacing one guess with another.
 */
/**
 * The most this layer may claim, until a measured run says otherwise.
 *
 * Below 0.5 so that it routes to a person by the rule the prompt already states: "Low confidence
 * routes the failure to a human". See the comment at the call site for the measurement.
 */
export const LLM_CONFIDENCE_CEILING = 0.45;

export function contradictsHistory(category: RootCause, context: FailureContext): string | null {
  if (category !== 'REAL_BUG' && category !== 'LOCATOR_DRIFT') return null;
  if (context.thisRun?.anotherAttemptPassed) {
    return `refused: another attempt of the same code passed in this run, so the failure is not deterministic and cannot be ${category}`;
  }
  if (/both failed and passed|not deterministic/i.test(context.history?.pattern ?? '')) {
    return `refused: the history says "${context.history.pattern}", so the failure is not deterministic and cannot be ${category}`;
  }
  return null;
}

export async function llmDiagnose(context: FailureContext, rules: Diagnosis, client: LlmClient, now = new Date()): Promise<Diagnosis> {
  try {
    const raw = await client.complete({ system: SYSTEM_PROMPT, user: JSON.stringify(context), schemaName: OUTPUT_SCHEMA_NAME, schema: OUTPUT_SCHEMA });
    const out = parseLlmOutput(raw);
    const refused = contradictsHistory(out.category, context);
    if (refused) {
      return {
        category: 'UNKNOWN',
        confidence: 0,
        source: 'llm',
        model: client.model,
        engineVersion: `${rules.engineVersion}+${PROMPT_VERSION}`,
        diagnosedAt: now.toISOString(),
        evidence: [
          { source: 'llm', message: `the model said ${out.category} (${out.confidence.toFixed(2)}): ${out.reasoning}` },
          { source: 'rules', message: refused },
        ],
      };
    }
    return {
      category: out.category,
      // Capped, because the number it reports is not the number it earns.
      //
      // Measured against 752 real labelled CI failures from WordPress/gutenberg - labels taken from
      // what the developer actually changed to fix each one - this layer decided 90 and got 16
      // right: **17.8%**. Seventy per cent of those failures are TIMING, so answering "TIMING" to
      // everything would have scored about 70%. The model is four times worse than the most trivial
      // baseline there is, and it was reporting 0.90 to 0.96 while being wrong.
      //
      // The rules layer, on the same data, is 98.5% and keeps its own confidence untouched.
      //
      // Nothing is discarded: the category and the reasoning are still reported, and a person still
      // sees them. What changes is that no consumer downstream can mistake this for a settled
      // answer - 0.7 is where a rule becomes actionable and 0.85 is where a fix may be attempted,
      // and a layer at 17.8% has no business clearing either. Raise this when a measured run earns
      // it, and not before.
      confidence: Math.min(out.confidence, LLM_CONFIDENCE_CEILING),
      source: 'llm',
      model: client.model,
      engineVersion: `${rules.engineVersion}+${PROMPT_VERSION}`,
      diagnosedAt: now.toISOString(),
      evidence: [
        { source: 'llm', message: out.reasoning },
        ...out.evidence.map((message) => ({ source: 'llm', message })),
        // Keep what the rules ruled out: the LLM decision sits on top of it.
        ...rules.evidence,
      ],
    };
  } catch (error) {
    recordFailure();
    return { ...rules, evidence: [...rules.evidence, { source: 'llm', message: `LLM layer failed, left UNKNOWN: ${truncate(String(error), 200)}` }] };
  }
}
