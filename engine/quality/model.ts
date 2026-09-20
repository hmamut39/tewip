// The model Tewip writes with. Triage uses a small, fast model because the deterministic rules do
// most of that work; planning and writing tests are open-ended, so they use a stronger one.
// Settings: TEWIP_WRITE_MODEL (default below), TEWIP_WRITE_REASONING (default medium).
import { join } from 'node:path';
import { cachedClient, loadDotEnv, type LlmClient } from '../llm/client.ts';
import { clientFor, modelChoiceFromEnv } from '../llm/providers.ts';

export const DEFAULT_WRITE_MODEL = 'gpt-5.5';

/** The writing client, or null when no model is configured (writing needs one; triage does not). */
export function writerFromEnv(projectRoot: string): LlmClient | null {
  loadDotEnv();
  const choice = modelChoiceFromEnv('write');
  if (!choice) return null;
  const client = clientFor(choice);
  // Same request, same answer, no second charge: kept with the project like the rest of .tewip.
  return cachedClient(client, join(projectRoot, '.tewip', 'writer-cache.jsonl'));
}
