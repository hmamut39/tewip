// The full ORIENT step: deterministic rules first; only what they leave UNKNOWN goes to the
// LLM layer (when one is configured). Used by the reporter, the diagnose CLI and the eval.
import type { Diagnosis, TriageRecord } from '../reporters/types.ts';
import { diagnoseRecords } from './engine.ts';
import type { HistoryIndex } from './history.ts';
import type { LlmClient } from './llm/client.ts';
import { buildFailureContext } from './llm/context.ts';
import { llmDiagnose } from './llm/llm-diagnose.ts';

export interface PipelineOptions {
  /** Parallel LLM requests. */
  concurrency?: number;
  now?: Date;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function diagnosePipeline(
  targets: TriageRecord[],
  index: HistoryIndex,
  llm: LlmClient | null,
  { concurrency = 4, now = new Date() }: PipelineOptions = {},
): Promise<Diagnosis[]> {
  const rules = diagnoseRecords(targets, index, now);
  if (!llm) return rules;

  const unknown = targets.map((record, i) => ({ record, i })).filter(({ i }) => rules[i].category === 'UNKNOWN');
  const final = [...rules];
  await mapLimit(unknown, concurrency, async ({ record, i }) => {
    const context = buildFailureContext(record, index.historyAsOf(record.testId, record.runId), index.runContext(record.runId), rules[i]);
    final[i] = await llmDiagnose(context, rules[i], llm, now);
  });
  return final;
}
