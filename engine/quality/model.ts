// The model Tewip writes with. Triage uses a small, fast model because the deterministic rules do
// most of that work; planning and writing tests are open-ended, so they use a stronger one.
// Settings: TEWIP_WRITE_MODEL (default below), TEWIP_WRITE_REASONING (default medium).
import { join } from 'node:path';
import { cachedClient, loadDotEnv, openAiClient, type LlmClient } from '../llm/client.ts';

export const DEFAULT_WRITE_MODEL = 'gpt-5.5';

/** The writing client, or null when no API key is set (writing needs a model; triage does not). */
export function writerFromEnv(projectRoot: string): LlmClient | null {
  loadDotEnv();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const client = openAiClient({
    apiKey,
    model: process.env.TEWIP_WRITE_MODEL || DEFAULT_WRITE_MODEL,
    reasoningEffort: process.env.TEWIP_WRITE_REASONING || 'medium',
    baseUrl: process.env.OPENAI_BASE_URL || undefined,
  });
  // Same request, same answer, no second charge: kept with the project like the rest of .tewip.
  return cachedClient(client, join(projectRoot, '.tewip', 'writer-cache.jsonl'));
}
