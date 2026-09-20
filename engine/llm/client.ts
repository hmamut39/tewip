// LLM provider access. The engine only sees LlmClient, so the provider or model can change
// (or be compared in the eval) without touching diagnosis code.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, DATA_DIR, PROJECT_ROOT, readJsonl } from '../../reporters/store.ts';
import { truncate } from '../signature.ts';
import { clientFor, modelChoiceFromEnv } from './providers.ts';
import { recordCacheHit, recordCall, recordRefusal } from './usage.ts';

export interface LlmRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: object;
}

export interface LlmClient {
  /** Model id plus settings, e.g. "gpt-5.4-mini (reasoning low)". Stored on each diagnosis. */
  readonly model: string;
  /** Returns the model's JSON text. Throws on transport, API or refusal errors. */
  complete(request: LlmRequest): Promise<string>;
}

export const DEFAULT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_REASONING = 'low';
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;
/** TEWIP_LLM_CACHE moves the cache, e.g. into the project the command line runs in. */
const CACHE_FILE = process.env.TEWIP_LLM_CACHE || join(DATA_DIR, 'llm-cache.jsonl');

let envLoaded = false;

/** Loads <project>/.env once. Variables already set in the environment win. */
export function loadDotEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = join(PROJECT_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

interface OpenAiOptions {
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  baseUrl?: string;
}

export function openAiClient({ apiKey, model, reasoningEffort, baseUrl = 'https://api.openai.com/v1' }: OpenAiOptions): LlmClient {
  return {
    model: reasoningEffort ? `${model} (reasoning ${reasoningEffort})` : model,
    async complete({ system, user, schemaName, schema }) {
      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      });

      const startedAt = Date.now();
      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS) throw new Error(`OpenAI request failed: ${String(error)}`);
          await sleep(2000 * attempt);
          continue;
        }
        if (res.ok) {
          const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
          };
          const u = json.usage;
          recordCall(Date.now() - startedAt, { prompt: u?.prompt_tokens, completion: u?.completion_tokens, cached: u?.prompt_tokens_details?.cached_tokens }, model);
          const message = json.choices?.[0]?.message;
          if (message?.refusal) throw new Error(`model refused: ${truncate(message.refusal, 200)}`);
          if (typeof message?.content !== 'string') throw new Error('model returned no content');
          return message.content;
        }
        const detail = truncate(await res.text(), 300);
        if ((res.status !== 429 && res.status < 500) || attempt >= MAX_ATTEMPTS) throw new Error(`OpenAI API ${res.status}: ${detail}`);
        await sleep(2000 * attempt);
      }
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CacheEntry {
  key: string;
  model: string;
  response: string;
  at: string;
}

/**
 * Caches responses in data/llm-cache.jsonl (gitignored), keyed by model + full request, so
 * re-running the eval costs nothing and any prompt or context change misses the cache.
 */
export function cachedClient(inner: LlmClient, file = CACHE_FILE): LlmClient {
  let cache: Map<string, string> | undefined;
  const entries = () => (cache ??= new Map(readJsonl<CacheEntry>(file).map((e) => [e.key, e.response])));
  return {
    model: inner.model,
    async complete(request) {
      const key = createHash('sha256').update(JSON.stringify([inner.model, request])).digest('hex');
      const hit = entries().get(key);
      if (hit !== undefined) {
        recordCacheHit();
        return hit;
      }
      const response = await inner.complete(request);
      entries().set(key, response);
      appendJsonl(file, [{ key, model: inner.model, response, at: new Date().toISOString() } satisfies CacheEntry]);
      return response;
    },
  };
}

/**
 * The configured client, or null when the LLM layer is off (no OPENAI_API_KEY, or
 * TRIAGE_LLM=off). Settings: TRIAGE_LLM_MODEL, TRIAGE_LLM_REASONING, TRIAGE_LLM_CACHE=off.
 */
export function llmFromEnv(): LlmClient | null {
  loadDotEnv();
  if (process.env.TRIAGE_LLM === 'off') return null;
  const choice = modelChoiceFromEnv('triage');
  if (!choice) return null;
  const client = clientFor(choice);
  // The budget sits inside the cache: a cached answer never reaches it, so it is free, and only
  // real calls to the model count against TRIAGE_LLM_MAX_CALLS.
  const budget = Number(process.env.TRIAGE_LLM_MAX_CALLS);
  const capped = Number.isFinite(budget) && budget > 0 ? budgetedClient(client, budget) : client;
  return process.env.TRIAGE_LLM_CACHE === 'off' ? capped : cachedClient(capped);
}

/** Raised when the per-process call budget is used up; the pipeline keeps the rules' answer. */
export class LlmBudgetError extends Error {}

/**
 * A cap on how many model calls one process may make (TRIAGE_LLM_MAX_CALLS). Cache hits are
 * free and do not count. A guardrail for CI: a huge failed run cannot run up an unbounded bill.
 */
export function budgetedClient(inner: LlmClient, maxCalls: number): LlmClient {
  // Counted when the call starts, not when it returns: several requests run in parallel, and a
  // budget that only counts finished calls would let a burst overshoot it.
  let started = 0;
  return {
    model: inner.model,
    async complete(request) {
      if (started >= maxCalls) {
        recordRefusal();
        throw new LlmBudgetError(`AI call budget reached (TRIAGE_LLM_MAX_CALLS=${maxCalls}); keeping the rules' answer`);
      }
      started++;
      return inner.complete(request);
    },
  };
}
