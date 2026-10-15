// Phase 47: running Tewip against a model on your own machine.
//
// This matters for one reason. A hospital, a bank or a government department cannot send source code
// to a hosted API, and those are exactly the organisations the field trials have been aimed at. The
// provider existed - `TEWIP_PROVIDER=ollama`, keyless, pointed at 127.0.0.1 - and had never been run
// against a server. It was configured on reasoning, which is the same mistake Phase 45 found in C#.
//
// Put in front of a real OpenAI-compatible server, two of the three commonest local replies crashed
// it outright, and the one error a first-time user is most likely to see named the wrong product.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, describe, it } from 'node:test';
import { jsonFromModel } from '../llm/json-from-model.ts';
import { clientFor, modelChoiceFromEnv } from '../llm/providers.ts';

describe('the JSON a model meant to send', () => {
  const sound = '{"category":"REAL_BUG","confidence":0.9}';

  it('reads a bare object, which is all a constrained model ever sends', () => {
    assert.deepEqual(jsonFromModel(sound), { category: 'REAL_BUG', confidence: 0.9 });
  });

  it('reads it out of a markdown fence', () => {
    // `JSON.parse` on this threw SyntaxError: Unexpected token '`'. OpenAI's strict json_schema
    // constrains generation so it never happens there; an unconstrained local model does it by habit.
    assert.deepEqual(jsonFromModel('```json\n' + sound + '\n```'), { category: 'REAL_BUG', confidence: 0.9 });
    assert.deepEqual(jsonFromModel('```\n' + sound + '\n```'), { category: 'REAL_BUG', confidence: 0.9 });
  });

  it('reads it out of a sentence of preamble', () => {
    assert.deepEqual(jsonFromModel(`Here is the analysis:\n\n${sound}`), { category: 'REAL_BUG', confidence: 0.9 });
    assert.deepEqual(jsonFromModel(`Sure!\n\`\`\`\n${sound}\n\`\`\`\nHope that helps.`), { category: 'REAL_BUG', confidence: 0.9 });
  });

  it('reads an array, which plan and write can both legitimately return', () => {
    assert.deepEqual(jsonFromModel('```json\n[{"id":1}]\n```'), [{ id: 1 }]);
  });

  it('still refuses a reply with no JSON in it, and quotes what came back', () => {
    // This is extraction, not repair. A model that answers in prose is an error, not a puzzle.
    assert.throws(() => jsonFromModel('I am not able to analyse this failure.'), /did not return JSON: I am not able/);
    assert.throws(() => jsonFromModel(''), /did not return JSON/);
  });

  it('does not invent an object out of a broken one', () => {
    assert.throws(() => jsonFromModel('{"category": "REAL_BUG",'), /did not return JSON/);
  });
});

describe('talking to a server that is not OpenAI', () => {
  // Every server, not the last one: closing only `server` left the earlier listeners open and the
  // test process never exited. `node --test` then hangs with everything passing, which is a worse
  // failure than a red test because it looks like the suite is still working.
  const started: Server[] = [];
  const serve = async (status: number, body: unknown): Promise<string> => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    started.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
  };
  after(() => {
    for (const s of started) s.close();
  });

  const withEnv = async (vars: Record<string, string>, run: () => Promise<void>) => {
    const before = { ...process.env };
    for (const key of ['TEWIP_PROVIDER', 'TEWIP_BASE_URL', 'TEWIP_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
    Object.assign(process.env, vars);
    try {
      await run();
    } finally {
      process.env = before;
    }
  };

  it('names the provider the person configured, not OpenAI', async () => {
    // "OpenAI API 400" is a confusing thing to read when you are running Ollama.
    const baseUrl = await serve(400, { error: 'model not found' });
    await withEnv({ TEWIP_PROVIDER: 'ollama', TEWIP_BASE_URL: baseUrl }, async () => {
      const client = clientFor(modelChoiceFromEnv('triage')!);
      await assert.rejects(client.complete({ system: 's', user: 'u', schemaName: 'n', schema: {} }), /ollama API 400/);
    });
  });

  it('accepts a reply that arrives fenced, end to end', async () => {
    const baseUrl = await serve(200, { choices: [{ message: { content: '```json\n{"ok":true}\n```' } }], usage: {} });
    await withEnv({ TEWIP_PROVIDER: 'ollama', TEWIP_BASE_URL: baseUrl }, async () => {
      const client = clientFor(modelChoiceFromEnv('triage')!);
      const raw = await client.complete({ system: 's', user: 'u', schemaName: 'n', schema: {} });
      assert.deepEqual(jsonFromModel(raw), { ok: true });
    });
  });
});
