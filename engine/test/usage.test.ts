// Unit tests for the cost/latency guardrails: the call budget and the pipeline's fallback when
// the AI layer cannot answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { budgetedClient, LlmBudgetError, type LlmClient } from '../llm/client.ts';
import { resetLlmUsage, llmUsage, usageLine } from '../llm/usage.ts';
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
