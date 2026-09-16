import { relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { resolveBranch, resolveGitSha, resolveRunId } from './run-context.ts';
import { appendJsonl, PROJECT_ROOT, readRunSummaries, readTriageRecords, RUNS_FILE, TRIAGE_FILE } from './store.ts';
import { SCHEMA_VERSION, type RunSummary, type TriageAttachment, type TriageRecord } from './types.ts';

const COLLECTED_ATTACHMENTS = new Set(['trace', 'screenshot', 'error-context']);

const projectPath = (p: string) => relative(PROJECT_ROOT, p).split(sep).join('/');

export function testIdOf(test: TestCase): string {
  return test.titlePath().filter(Boolean).join(' > ');
}

/**
 * Collects failed / timed-out attempts and appends them to data/triage.jsonl when the
 * run ends. Also appends one run summary line to data/runs.jsonl so failure rates can
 * be computed later.
 */
export default class TriageReporter implements Reporter {
  private readonly runId = resolveRunId();
  private readonly gitSha = resolveGitSha();
  private startedAt = new Date().toISOString();
  private readonly records: TriageRecord[] = [];
  private readonly attempts: Record<string, number> = {};

  onBegin(): void {
    this.startedAt = new Date().toISOString();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const testId = testIdOf(test);
    if (result.status !== 'skipped' && result.status !== 'interrupted') {
      this.attempts[testId] = (this.attempts[testId] ?? 0) + 1;
    }
    if (result.status !== 'failed' && result.status !== 'timedOut') return;
    this.records.push(this.toRecord(test, result, testId));
  }

  async onEnd(result: FullResult): Promise<void> {
    const summary: RunSummary = {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      gitSha: this.gitSha,
      branch: resolveBranch(),
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      status: result.status,
      attempts: this.attempts,
    };
    const records = await this.enrich(this.records, summary);
    appendJsonl(TRIAGE_FILE, records);
    appendJsonl(RUNS_FILE, [summary]);

    const by = (source: string) => records.filter((r) => r.diagnosis?.source === source && r.diagnosis.category !== 'UNKNOWN').length;
    const unknown = records.filter((r) => !r.diagnosis || r.diagnosis.category === 'UNKNOWN').length;
    console.log(
      `[triage] ${records.length} failure record(s) appended to ${projectPath(TRIAGE_FILE)} (runId=${this.runId}); ` +
        `rules classified ${by('rules')}, LLM ${by('llm')}, ${unknown} UNKNOWN`,
    );
  }

  /**
   * Diagnosis step: runs after the run finishes and before records are persisted. Rules
   * decide first; failures they leave UNKNOWN go to the LLM layer when OPENAI_API_KEY is set
   * (TRIAGE_LLM=off disables it). A failing engine must never cost us the collected data.
   */
  protected async enrich(records: TriageRecord[], summary: RunSummary): Promise<TriageRecord[]> {
    if (records.length === 0) return records;
    try {
      const index = new HistoryIndex([...readTriageRecords(), ...records], [...readRunSummaries(), summary]);
      const diagnoses = await diagnosePipeline(records, index, llmFromEnv());
      return records.map((record, i) => ({ ...record, diagnosis: diagnoses[i] }));
    } catch (error) {
      console.warn(`[triage] rule engine failed, saving records without a diagnosis: ${String(error)}`);
      return records;
    }
  }

  printsToStdio(): boolean {
    return false;
  }

  private toRecord(test: TestCase, result: TestResult, testId: string): TriageRecord {
    const error = result.error ?? result.errors[0];
    const attachments: TriageAttachment[] = result.attachments
      .filter((a) => COLLECTED_ATTACHMENTS.has(a.name) && a.path)
      .map((a) => ({
        name: a.name as TriageAttachment['name'],
        contentType: a.contentType,
        path: projectPath(a.path!),
      }));

    return {
      schemaVersion: SCHEMA_VERSION,
      testId,
      file: projectPath(test.location.file),
      status: result.status as TriageRecord['status'],
      errorMessage: stripVTControlCharacters(error?.message ?? ''),
      errorStack: stripVTControlCharacters(error?.stack ?? ''),
      duration: result.duration,
      retry: result.retry,
      attachments,
      runId: this.runId,
      gitSha: this.gitSha,
      timestamp: new Date(result.startTime.getTime() + result.duration).toISOString(),
    };
  }
}
