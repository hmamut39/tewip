// Phase-3 step for one failure the rules left UNKNOWN: ask the model, validate its answer
// against the fixed taxonomy, and return a diagnosis. Any failure keeps the rules' UNKNOWN.
import { recordFailure } from './usage.ts';
import { ROOT_CAUSES, type Diagnosis, type RootCause } from '../../reporters/types.ts';
import { truncate } from '../signature.ts';
import type { LlmClient } from './client.ts';
import type { FailureContext } from './context.ts';
import { OUTPUT_SCHEMA, OUTPUT_SCHEMA_NAME, PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';

export interface LlmOutput {
  category: RootCause;
  confidence: number;
  reasoning: string;
  evidence: string[];
}

/** Validates the model's JSON. Throws on anything outside the contract. */
export function parseLlmOutput(raw: string): LlmOutput {
  const value = JSON.parse(raw) as Partial<LlmOutput>;
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

export async function llmDiagnose(context: FailureContext, rules: Diagnosis, client: LlmClient, now = new Date()): Promise<Diagnosis> {
  try {
    const raw = await client.complete({ system: SYSTEM_PROMPT, user: JSON.stringify(context), schemaName: OUTPUT_SCHEMA_NAME, schema: OUTPUT_SCHEMA });
    const out = parseLlmOutput(raw);
    return {
      category: out.category,
      confidence: out.confidence,
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
