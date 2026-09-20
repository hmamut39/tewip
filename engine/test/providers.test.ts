// Tewip must work for a team that has no OpenAI account: any OpenAI-compatible endpoint, Anthropic's
// own API, or a model running on the machine itself.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clientFor, modelChoiceFromEnv, noModelHelp, PROVIDERS } from '../llm/providers.ts';

const VARS = ['TEWIP_PROVIDER', 'TEWIP_API_KEY', 'TEWIP_MODEL', 'TEWIP_BASE_URL', 'TEWIP_WRITE_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'TRIAGE_LLM_MODEL'];
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
function env(values: Record<string, string | undefined>): void {
  for (const v of VARS) delete process.env[v];
  for (const [k, value] of Object.entries(values)) if (value !== undefined) process.env[k] = value;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe('choosing a model provider', () => {
  it('defaults to OpenAI, with a small model for triage and a stronger one for writing', () => {
    env({ TEWIP_API_KEY: 'k' });
    assert.deepEqual(modelChoiceFromEnv('triage')?.provider, 'openai');
    assert.equal(modelChoiceFromEnv('triage')?.model, 'gpt-5.4-mini');
    assert.equal(modelChoiceFromEnv('write')?.model, 'gpt-5.5');
  });

  it('keeps working for anyone already using the OpenAI names', () => {
    env({ OPENAI_API_KEY: 'old-key', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', TRIAGE_LLM_MODEL: 'mistral' });
    const choice = modelChoiceFromEnv('triage')!;
    assert.equal(choice.apiKey, 'old-key');
    assert.equal(choice.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(choice.model, 'mistral');
  });

  it('talks to Anthropic with its own API, and sends no reasoning setting', () => {
    env({ TEWIP_PROVIDER: 'anthropic', TEWIP_API_KEY: 'k' });
    const choice = modelChoiceFromEnv('triage')!;
    assert.equal(choice.provider, 'anthropic');
    assert.match(choice.model, /^claude-/);
    assert.equal(choice.reasoningEffort, undefined, 'reasoning effort is an OpenAI setting');
    assert.equal(clientFor(choice).model, choice.model);
  });

  it("uses Google's OpenAI-compatible endpoint for Gemini", () => {
    env({ TEWIP_PROVIDER: 'google', TEWIP_API_KEY: 'k' });
    const choice = modelChoiceFromEnv('triage')!;
    assert.match(choice.baseUrl ?? '', /generativelanguage\.googleapis\.com/);
    assert.match(choice.model, /^gemini-/);
  });

  it('runs against a model on this machine with no key and no account at all', () => {
    env({ TEWIP_PROVIDER: 'ollama' });
    const choice = modelChoiceFromEnv('triage')!;
    assert.equal(choice.apiKey, '');
    assert.match(choice.baseUrl ?? '', /127\.0\.0\.1:11434/);
    assert.ok(clientFor(choice).model.length > 0);
  });

  it('says there is no model, rather than guessing, when nothing is set up', () => {
    env({});
    assert.equal(modelChoiceFromEnv('triage'), null);
    const help = noModelHelp();
    for (const id of Object.keys(PROVIDERS)) assert.match(help, new RegExp(id));
    assert.match(help, /no account and no data leaving it/);
  });
});
