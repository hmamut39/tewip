// Unit tests for the LLM layer with a fake client: contract enforcement and routing.
// No network calls; nothing here measures how well a real model classifies.
import assert from 'node:assert/strict';
import { LLM_CONFIDENCE_CEILING, contradictsHistory } from '../llm/llm-diagnose.ts';
import { describe, it } from 'node:test';
import type { Diagnosis, RunSummary, TriageRecord } from '../../reporters/types.ts';
import { HistoryIndex } from '../history.ts';
import type { LlmClient } from '../llm/client.ts';
import { errorScenarioOf, historyPattern, type FailureContext } from '../llm/context.ts';
import { llmDiagnose, parseLlmOutput } from '../llm/llm-diagnose.ts';
import { diagnosePipeline } from '../pipeline.ts';
import { lastMainFrameDom, notableElements, type FrameSnapshot } from '../trace/dom.ts';

const UNKNOWN: Diagnosis = {
  category: 'UNKNOWN',
  confidence: 0,
  source: 'rules',
  engineVersion: 'rules-1',
  diagnosedAt: '2026-01-01T00:00:00.000Z',
  evidence: [{ source: 'locator-drift', message: 'nothing similar on the page' }],
};
const CONTEXT = {} as FailureContext;

function fakeClient(reply: string | Error): LlmClient & { calls: number } {
  return {
    model: 'fake-model',
    calls: 0,
    async complete() {
      this.calls++;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

describe('LLM output contract', () => {
  it('accepts a valid answer and clamps confidence', () => {
    const out = parseLlmOutput('{"category":"TIMING","confidence":1.4,"reasoning":"r","evidence":["e"]}');
    assert.equal(out.category, 'TIMING');
    assert.equal(out.confidence, 1);
  });

  it('rejects a category outside the fixed taxonomy', () => {
    assert.throws(() => parseLlmOutput('{"category":"FLAKY","confidence":0.9,"reasoning":"r","evidence":[]}'), /outside the taxonomy/);
  });
});

describe('llmDiagnose', () => {
  it('turns a valid answer into an llm diagnosis and keeps the rules evidence', async () => {
    const d = await llmDiagnose(CONTEXT, UNKNOWN, fakeClient('{"category":"REAL_BUG","confidence":0.8,"reasoning":"why","evidence":["fact"]}'));
    assert.equal(d.category, 'REAL_BUG');
    assert.equal(d.source, 'llm');
    assert.equal(d.model, 'fake-model');
    assert.ok(d.evidence.some((e) => e.source === 'locator-drift'));
  });

  it('keeps UNKNOWN when the model answers outside the contract', async () => {
    const d = await llmDiagnose(CONTEXT, UNKNOWN, fakeClient('{"category":"FLAKY","confidence":0.9,"reasoning":"r","evidence":[]}'));
    assert.equal(d.category, 'UNKNOWN');
    assert.equal(d.confidence, 0);
    assert.match(d.evidence.at(-1)!.message, /LLM layer failed/);
  });

  it('keeps UNKNOWN when the API call fails', async () => {
    const d = await llmDiagnose(CONTEXT, UNKNOWN, fakeClient(new Error('OpenAI API 503')));
    assert.equal(d.category, 'UNKNOWN');
  });
});

describe('pipeline routing', () => {
  it('sends only the failures the rules left UNKNOWN to the LLM', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    const mk = (testId: string, errorMessage: string): TriageRecord => ({
      schemaVersion: 1, testId, file: 'x', status: 'failed', errorMessage, errorStack: '', duration: 1, retry: 0, attachments: [], runId: 'r1', gitSha: '', timestamp: at,
    });
    const records = [mk('net', 'Error: page.goto: net::ERR_CONNECTION_REFUSED'), mk('odd', 'Error: something unusual')];
    const summary: RunSummary = { schemaVersion: 1, runId: 'r1', gitSha: '', startedAt: at, finishedAt: at, status: 'failed', attempts: { net: 1, odd: 1 } };
    const client = fakeClient('{"category":"TEST_DATA","confidence":0.6,"reasoning":"r","evidence":[]}');

    const [net, odd] = await diagnosePipeline(records, new HistoryIndex(records, [summary]), client);
    assert.equal(client.calls, 1);
    assert.equal(net.source, 'rules');
    assert.equal(net.category, 'ENV');
    assert.equal(odd.source, 'llm');
  });
});

describe('history pattern', () => {
  it('tells "broken by this commit" apart from "flaky on the same code"', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
    const fail = (runId: string, m: number, sha: string): TriageRecord => ({
      schemaVersion: 1, testId: 't', file: 'x', status: 'failed', errorMessage: 'Error: x', errorStack: '', duration: 1, retry: 0, attachments: [], runId, gitSha: sha, timestamp: at(m),
    });
    const run = (runId: string, m: number, sha: string, attempts: number): RunSummary => ({
      schemaVersion: 1, runId, gitSha: sha, startedAt: at(m), finishedAt: at(m), status: 'x', attempts: { t: attempts },
    });
    const records = [fail('r3', 3, 'new'), fail('r3', 3, 'new'), fail('r3', 3, 'new')];
    const index = new HistoryIndex(records, [run('r1', 1, 'old', 1), run('r2', 2, 'old', 1), run('r3', 3, 'new', 3)]);
    assert.match(historyPattern(index.historyAsOf('t', 'r3')), /every attempt on this commit failed \(3\/3\).*passed 2 time/);
  });
});

describe('error-scenario detection', () => {
  it('flags tests whose name says they provoke failures', () => {
    assert.match(errorScenarioOf('chromium > upload.spec.js > Upload > does not claim completion for a file the server rejects') ?? '', /rejects/);
    assert.match(errorScenarioOf('chromium > media.spec.js > Media > recovers from a transient upload failure via automatic retry') ?? '', /transient/);
    assert.equal(errorScenarioOf('chromium > image.spec.js > Image > can be replaced by dragging'), null);
  });
});

describe('trace DOM reconstruction', () => {
  it('resolves [[snapshotsAgo, nodeIndex]] references against earlier snapshots', () => {
    const first: FrameSnapshot = { frameId: 'f', frameUrl: 'http://app/', isMainFrame: true, html: ['HTML', {}, ['BODY', {}, ['BUTTON', { id: 'buy' }, 'Buy']]] };
    // Post-order of the first snapshot: "Buy"(0), BUTTON(1), BODY(2), HTML(3). Reuse the button.
    const second: FrameSnapshot = { frameId: 'f', frameUrl: 'http://app/', isMainFrame: true, html: ['HTML', {}, ['BODY', {}, [[1, 1]], ['P', {}, 'done']]] };
    const dom = lastMainFrameDom([first, second]);
    assert.ok(dom);
    assert.deepEqual(notableElements(dom.root).elements, ['<button id="buy">Buy</button>']);
  });
});


// Phase 55: measured against 547 real labelled CI failures from WordPress/gutenberg.
//
//   Rules layer:  460 decided, 451 correct (98.0%)
//   LLM layer:     87 decided,   9 correct (10.3%)
//
// Random across five categories is 20%. Almost every miss was a flaky timing failure called
// REAL_BUG or LOCATOR_DRIFT at 0.9 confidence or higher - the most expensive mistake this tool can
// make, because it sends a team hunting a bug that is not there and sounds certain doing it.
//
// The prompt has told the model since llm-6 that a failure which passed on another attempt cannot be
// either of those. An instruction in a prompt is a request, not a guarantee.
describe('a verdict the run history already rules out', () => {
  const context = (over: Record<string, unknown> = {}) =>
    ({
      thisRun: { attempts: 2, failedAttempts: 1, anotherAttemptPassed: false },
      history: { pattern: 'every recorded attempt failed (3/3) and there is no passing run to compare with' },
      ...over,
    }) as never;

  it('refuses REAL_BUG when another attempt of the same code passed', () => {
    const refused = contradictsHistory('REAL_BUG', context({ thisRun: { attempts: 2, failedAttempts: 1, anotherAttemptPassed: true } }));
    assert.match(refused ?? '', /not deterministic and cannot be REAL_BUG/);
  });

  it('refuses LOCATOR_DRIFT on the same evidence, because a drifted selector fails every time', () => {
    const refused = contradictsHistory('LOCATOR_DRIFT', context({ thisRun: { attempts: 2, failedAttempts: 1, anotherAttemptPassed: true } }));
    assert.ok(refused);
  });

  it('refuses when the commit itself both failed and passed', () => {
    const refused = contradictsHistory('REAL_BUG', context({ history: { pattern: 'this commit both failed and passed (2/3 attempts failed): the failure is not deterministic' } }));
    assert.match(refused ?? '', /both failed and passed/);
  });

  it('leaves the categories that survive a retry alone', () => {
    // "This cannot be REAL_BUG" is not "this is TIMING". ENV and TEST_DATA both survive a retry, so
    // the guard refuses rather than rewrites, and the answer becomes UNKNOWN for a person to read.
    const flaky = context({ thisRun: { attempts: 2, failedAttempts: 1, anotherAttemptPassed: true } });
    assert.equal(contradictsHistory('TIMING', flaky), null);
    assert.equal(contradictsHistory('ENV', flaky), null);
    assert.equal(contradictsHistory('TEST_DATA', flaky), null);
  });

  it('allows REAL_BUG when every attempt really did fail', () => {
    // The guard must not swallow the finding the tool exists to make.
    assert.equal(contradictsHistory('REAL_BUG', context()), null);
    assert.equal(contradictsHistory('LOCATOR_DRIFT', context()), null);
  });
});

describe('what the model layer is allowed to claim', () => {
  it('caps its confidence at the measured ceiling', () => {
    // Measured against 752 real labelled CI failures from WordPress/gutenberg: 90 decided, 16
    // correct, 17.8%. Seventy per cent of those failures are TIMING, so answering TIMING to
    // everything scores about 70% - the model is four times worse than the most trivial baseline
    // there is, and it was reporting 0.90 to 0.96 while being wrong.
    assert.ok(LLM_CONFIDENCE_CEILING < 0.5, 'below the threshold that routes a failure to a person');
    assert.ok(LLM_CONFIDENCE_CEILING < 0.7, 'below the threshold at which a rule becomes actionable');
    assert.ok(LLM_CONFIDENCE_CEILING < 0.85, 'below the threshold at which a fix may be attempted');
  });
});
