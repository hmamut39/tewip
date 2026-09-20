// Anthropic's own API, for teams who have Claude rather than OpenAI. It has no "JSON schema
// response format", so the schema is given as a single tool the model must call: the arguments it
// passes back are the JSON Tewip asked for. Same LlmClient shape as every other provider, so the
// engine cannot tell the difference.
import { truncate } from '../signature.ts';
import type { LlmClient, LlmRequest } from './client.ts';
import { recordCall } from './usage.ts';

const VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;
const MAX_TOKENS = 4096;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface AnthropicResponse {
  content?: Array<{ type: string; input?: unknown; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  stop_reason?: string;
}

export function anthropicClient({ apiKey, model, baseUrl = 'https://api.anthropic.com/v1' }: AnthropicOptions): LlmClient {
  return {
    model,
    async complete({ system, user, schemaName, schema }: LlmRequest): Promise<string> {
      const body = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
        // One tool, and the model must use it: its arguments are the answer in the shape asked for.
        tools: [{ name: schemaName, description: 'Return the answer in this shape.', input_schema: schema }],
        tool_choice: { type: 'tool', name: schemaName },
      });
      const startedAt = Date.now();
      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS) throw new Error(`Anthropic request failed: ${String(error)}`);
          await sleep(2000 * attempt);
          continue;
        }
        if (res.ok) {
          const json = (await res.json()) as AnthropicResponse;
          recordCall(Date.now() - startedAt, { prompt: json.usage?.input_tokens, completion: json.usage?.output_tokens, cached: json.usage?.cache_read_input_tokens }, model);
          const call = json.content?.find((c) => c.type === 'tool_use' && c.input !== undefined);
          if (!call) {
            const refusal = json.content?.find((c) => c.type === 'text')?.text;
            throw new Error(refusal ? `model refused: ${truncate(refusal, 200)}` : 'model returned no answer in the shape asked for');
          }
          return JSON.stringify(call.input);
        }
        const detail = truncate(await res.text(), 300);
        if ((res.status !== 429 && res.status < 500) || attempt >= MAX_ATTEMPTS) throw new Error(`Anthropic API ${res.status}: ${detail}`);
        await sleep(2000 * attempt);
      }
    },
  };
}
