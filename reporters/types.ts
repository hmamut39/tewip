/** Bump when the on-disk record shape changes incompatibly. */
export const SCHEMA_VERSION = 1;

export type FailureStatus = 'failed' | 'timedOut';

export interface TriageAttachment {
  name: 'trace' | 'screenshot';
  contentType: string;
  /** Path relative to the project root, forward slashes. */
  path: string;
}

/**
 * Reserved for the diagnosis layer (phase 2, LLM-backed). Phase 1 never sets it.
 * The shape is a draft and may change before phase 2 ships.
 */
export type FailureCategory =
  | 'missing-selector'
  | 'timeout'
  | 'assertion'
  | 'network'
  | 'flaky'
  | 'environment'
  | 'unknown';

export interface Diagnosis {
  category: FailureCategory;
  /** 0..1 */
  confidence: number;
  summary: string;
  suggestedAction?: string;
  /** Model identifier that produced this diagnosis. */
  model?: string;
  diagnosedAt: string;
}

/** One line of data/triage.jsonl — a single failed or timed-out test attempt. */
export interface TriageRecord {
  schemaVersion: number;
  /** titlePath() joined with ' > ', empty segments dropped. */
  testId: string;
  /** Spec file relative to the project root. */
  file: string;
  status: FailureStatus;
  errorMessage: string;
  errorStack: string;
  /** Milliseconds. */
  duration: number;
  retry: number;
  attachments: TriageAttachment[];
  runId: string;
  /** Empty string when no commit SHA is available in the environment. */
  gitSha: string;
  /** ISO-8601, when the attempt ended. */
  timestamp: string;
  diagnosis?: Diagnosis;
}

/**
 * One line of data/runs.jsonl. Failure records alone can't tell how often a test
 * ran, so the reporter also logs how many attempts each test had per run.
 */
export interface RunSummary {
  schemaVersion: number;
  runId: string;
  gitSha: string;
  startedAt: string;
  finishedAt: string;
  /** Overall result reported by Playwright. */
  status: string;
  /** testId -> number of attempts in this run (counts retries). */
  attempts: Record<string, number>;
}
