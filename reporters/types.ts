/** Bump when the on-disk record shape changes incompatibly. */
export const SCHEMA_VERSION = 1;

export type FailureStatus = 'failed' | 'timedOut';

export interface TriageAttachment {
  /** error-context is Playwright's error-context.md, which holds the page snapshot. */
  name: 'trace' | 'screenshot' | 'error-context';
  contentType: string;
  /** Path relative to the project root, forward slashes. */
  path: string;
}

/** The fixed root-cause taxonomy from ROADMAP.md. No layer may add to it. */
export const ROOT_CAUSES = ['REAL_BUG', 'LOCATOR_DRIFT', 'TIMING', 'ENV', 'TEST_DATA'] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

/** UNKNOWN is not a root cause: it means "not decided here", handed to the next layer. */
export type DiagnosisCategory = RootCause | 'UNKNOWN';

export interface Evidence {
  /** Id of the rule (or, from phase 3, the model) that produced this line. */
  source: string;
  message: string;
  /** Machine-readable facts a later action step can use, e.g. the drift candidate. */
  data?: Record<string, unknown>;
}

export interface Diagnosis {
  category: DiagnosisCategory;
  /** 0..1; always 0 for UNKNOWN. */
  confidence: number;
  /** Rule that decided the category; absent for UNKNOWN. */
  ruleId?: string;
  /** For a decision: why. For UNKNOWN: what each rule saw and why it declined. */
  evidence: Evidence[];
  source: 'rules' | 'llm';
  /** Rule-set version (phase 2) so stale diagnoses can be recomputed. */
  engineVersion: string;
  /** Model identifier, set only by the LLM layer. */
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
  /** Branch the run tested (e.g. main, or a pull request's branch); empty when unknown. */
  branch?: string;
  startedAt: string;
  finishedAt: string;
  /** Overall result reported by Playwright. */
  status: string;
  /** testId -> number of attempts in this run (counts retries). */
  attempts: Record<string, number>;
}
