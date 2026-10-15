// Which model Tewip talks to, and how. The engine only ever sees LlmClient, so a team can run
// Tewip on whatever they already pay for - or on nothing at all:
//
//   TEWIP_PROVIDER=openai|anthropic|google|azure|ollama|custom  (default: openai)
//   TEWIP_API_KEY=...        the key for that provider (not needed for a local Ollama)
//   TEWIP_MODEL=...          the model id, when the provider's default is not wanted
//   TEWIP_BASE_URL=...       any OpenAI-compatible endpoint (OpenRouter, Groq, vLLM, LM Studio)
//
// The older OPENAI_API_KEY / OPENAI_BASE_URL / TRIAGE_LLM_MODEL names still work, so nothing that
// already runs needs changing. With no key and no local server, the deterministic rules still
// answer most failures on their own.
import { anthropicClient } from './anthropic.ts';
import { openAiClient, type LlmClient } from './client.ts';

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'azure' | 'ollama' | 'custom';

interface Provider {
  /** Where its OpenAI-compatible endpoint lives; Anthropic has its own client instead. */
  baseUrl?: string;
  defaultModel: string;
  /** A local server needs no key. */
  keyless?: boolean;
  /** How to get started, shown when the key is missing. */
  hint: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: { defaultModel: 'gpt-5.4-mini', hint: 'create a key at platform.openai.com and set TEWIP_API_KEY' },
  anthropic: { defaultModel: 'claude-haiku-4-5-20251001', hint: 'create a key at console.anthropic.com and set TEWIP_API_KEY' },
  // Google publishes an OpenAI-compatible endpoint for Gemini.
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash', hint: 'create a key at aistudio.google.com and set TEWIP_API_KEY' },
  // Azure needs the full deployment URL, which only the team knows.
  azure: { defaultModel: 'gpt-4o-mini', hint: 'set TEWIP_BASE_URL to your Azure endpoint (https://<resource>.openai.azure.com/openai/deployments/<deployment>) and TEWIP_API_KEY to its key' },
  // Ollama runs models on your own machine: no account, no key, nothing leaves the computer.
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen3:8b', keyless: true, hint: 'install Ollama from ollama.com, then run: ollama pull qwen3:8b' },
  custom: { defaultModel: 'gpt-4o-mini', hint: 'set TEWIP_BASE_URL to any OpenAI-compatible endpoint (OpenRouter, Groq, Together, vLLM, LM Studio) and TEWIP_API_KEY if it needs one' },
};

export interface ModelChoice {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  reasoningEffort?: string;
}

const providerOf = (name: string | undefined): ProviderId => (name && name.toLowerCase() in PROVIDERS ? (name.toLowerCase() as ProviderId) : 'openai');

/**
 * What the environment asks for, or null when no model is configured at all. `purpose` only picks
 * which model setting to read: triage uses a small fast model, writing a stronger one.
 */
export function modelChoiceFromEnv(purpose: 'triage' | 'write'): ModelChoice | null {
  const provider = providerOf(process.env.TEWIP_PROVIDER);
  const spec = PROVIDERS[provider];
  const apiKey = (process.env.TEWIP_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = (process.env.TEWIP_BASE_URL || process.env.OPENAI_BASE_URL || spec.baseUrl || '').trim() || undefined;
  if (!apiKey && !spec.keyless) return null;
  const model =
    purpose === 'write'
      ? process.env.TEWIP_WRITE_MODEL || process.env.TEWIP_MODEL || (provider === 'openai' ? 'gpt-5.5' : spec.defaultModel)
      : process.env.TRIAGE_LLM_MODEL || process.env.TEWIP_MODEL || spec.defaultModel;
  const reasoningEffort = purpose === 'write' ? process.env.TEWIP_WRITE_REASONING || 'medium' : process.env.TRIAGE_LLM_REASONING || 'low';
  // Reasoning effort is an OpenAI setting; other providers reject it.
  return { provider, apiKey, model, baseUrl, reasoningEffort: provider === 'openai' || provider === 'azure' ? reasoningEffort : undefined };
}

/** A client for that choice: Anthropic has its own API shape, everything else speaks OpenAI's. */
export function clientFor(choice: ModelChoice): LlmClient {
  if (choice.provider === 'anthropic') return anthropicClient({ apiKey: choice.apiKey, model: choice.model, baseUrl: choice.baseUrl });
  return openAiClient({
    apiKey: choice.apiKey || 'local',
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
    baseUrl: choice.baseUrl,
    provider: choice.provider === 'custom' ? 'the configured endpoint' : choice.provider,
    hint: PROVIDERS[choice.provider].hint,
  });
}

/** What to tell someone who has no model configured, naming every way to get one. */
export function noModelHelp(): string {
  const lines = Object.entries(PROVIDERS).map(([id, p]) => `  TEWIP_PROVIDER=${id.padEnd(9)} ${p.hint}`);
  return ['No model is configured. Set TEWIP_API_KEY (and TEWIP_PROVIDER if not OpenAI):', ...lines, 'Free and private: TEWIP_PROVIDER=ollama runs a model on this machine, with no account and no data leaving it.'].join('\n');
}
