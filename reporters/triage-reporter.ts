import { relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { resolveGitSha, resolveRunId } from './run-context.ts';
import { appendJsonl, PROJECT_ROOT, RUNS_FILE, TRIAGE_FILE } from './store.ts';
import { SCHEMA_VERSION, type RunSummary, type TriageAttachment, type TriageRecord } from './types.ts';

const COLLECTED_ATTACHMENTS = new Set(['trace', 'screenshot']);

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
    const records = await this.enrich(this.records);
    appendJsonl(TRIAGE_FILE, records);

    const summary: RunSummary = {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      gitSha: this.gitSha,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      status: result.status,
      attempts: this.attempts,
    };
    appendJsonl(RUNS_FILE, [summary]);

    console.log(`[triage] ${records.length} failure record(s) appended to ${projectPath(TRIAGE_FILE)} (runId=${this.runId})`);
  }

  /**
   * Extension point for the diagnosis layer: runs after the run finishes and before
   * records are persisted. Phase 1 passes records through untouched; a subclass (or a
   * later composed step) can fill in `record.diagnosis` here.
   */
  protected async enrich(records: TriageRecord[]): Promise<TriageRecord[]> {
    return records;
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
