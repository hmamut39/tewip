// Unit tests for the cost/latency guardrails: the call budget and the pipeline's fallback when
// the AI layer cannot answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { budgetedClient, cachedClient, LlmBudgetError, type LlmClient } from '../llm/client.ts';
import { recordCall, resetLlmUsage, llmUsage, usageLine } from '../llm/usage.ts';
import { HistoryIndex } from '../history.ts';
import { diagnosePipeline } from '../pipeline.ts';

const request = { system: 's', user: 'u', schemaName: 'n', schema: {} };
const stub = (complete: LlmClient['complete']): LlmClient => ({ model: 'test-model', complete });

const record: TriageRecord = {
  schemaVersion: 1,
  testId: 'a.spec.ts > does a thing',
  file: 'a.spec.ts',
  status: 'failed',
  errorMessage: 'Error: something no rule understands',
  errorStack: '',
  duration: 1,
  retry: 0,
  attachments: [],
  runId: 'r1',
  gitSha: '',
  timestamp: '2026-01-01T00:00:00Z',
};
const summary: RunSummary = { schemaVersion: 1, runId: 'r1', gitSha: '', startedAt: record.timestamp, finishedAt: record.timestamp, status: 'failed', attempts: { [record.testId]: 1 } };

describe('AI call budget', () => {
  it('allows exactly the budgeted number of calls and refuses the rest', async () => {
    resetLlmUsage();
    let calls = 0;
    const client = budgetedClient(
      stub(async () => {
        calls++;
        return '{}';
      }),
      2,
    );
    await client.complete(request);
    await client.complete(request);
    await assert.rejects(() => client.complete(request), LlmBudgetError);
    assert.equal(calls, 2);
    assert.equal(llmUsage().refused, 1);
  });
});

describe('pipeline when the AI layer fails', () => {
  it("keeps the rules' answer and records why instead of losing the run", async () => {
    resetLlmUsage();
    const index = new HistoryIndex([record], [summary]);
    const client = stub(async () => {
      throw new LlmBudgetError('AI call budget reached');
    });
    const [d] = await diagnosePipeline([record], index, client);
    assert.equal(d.category, 'UNKNOWN');
    assert.ok(d.evidence.some((e) => /LLM layer failed.*budget/i.test(e.message)));
    assert.equal(llmUsage().failures, 1);
  });
});

describe('usage line', () => {
  it('says so plainly when nothing was asked of the model', () => {
    resetLlmUsage();
    assert.match(usageLine(), /no calls \(rules only\)/);
  });
});

describe('AI call budget and the cache', () => {
  it('does not spend the budget on answers the cache already has', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'triage-cache-')), 'cache.jsonl');
    let calls = 0;
    const model = stub(async () => {
      calls++;
      return '{}';
    });
    const client = cachedClient(budgetedClient(model, 1), file);
    await client.complete(request); // real call: uses the single budgeted call
    await client.complete(request); // same request: from the cache, free
    await client.complete(request);
    assert.equal(calls, 1);
    await assert.rejects(() => client.complete({ ...request, user: 'a different question' }), LlmBudgetError);
  });
});


describe('what a run cost', () => {
  it('prices each call by its own model, with cached input at the cached rate', () => {
    resetLlmUsage();
    // gpt-5.4-mini: $0.75 in, $0.075 cached, $4.50 out per million; gpt-5.5: $5 in, $30 out.
    recordCall(10, { prompt: 1_000_000, completion: 100_000, cached: 500_000 }, 'gpt-5.4-mini');
    recordCall(10, { prompt: 100_000, completion: 10_000 }, 'gpt-5.5');
    assert.ok(Math.abs(llmUsage().costUsd - (0.375 + 0.0375 + 0.45 + 0.5 + 0.3)) < 1e-9);
    assert.match(usageLine(), /cost: ~\$1\.6625$/);
  });

  it('says when a model has no known price instead of guessing', () => {
    resetLlmUsage();
    recordCall(10, { prompt: 1000, completion: 10 }, 'some-local-model');
    assert.match(usageLine(), /unknown model price/);
  });
});
