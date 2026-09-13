// Builds the structured summary sent to the model for one failure. Everything is clipped
// and summarised; raw logs, traces and full DOM never leave this function.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../reporters/store.ts';
import type { Diagnosis, TriageRecord } from '../../reporters/types.ts';
import type { RunContext, TestHistory } from '../history.ts';
import { errorShape, truncate } from '../signature.ts';
import { errorContextPath } from '../snapshot.ts';
import { summarizeTrace, type TraceSummary } from '../trace/trace-summary.ts';

export interface FailureContext {
  test: { id: string; file: string; status: string; durationMs: number; retry: number };
  error: { message: string; callLog: string[] };
  /** Lines around the failing line, comments removed. Null when unavailable. */
  failingCode: string[] | null;
  history: {
    runs: number;
    failures: number;
    failureRatePct: number;
    distinctErrors: number;
    failingStreak: number;
    passesBeforeStreak: number;
    failuresBeforeStreak: number;
  };
  run: { testsAttempted: number; testsFailed: number; otherFailures: string[] };
  /** What the phase-2 rules examined and why they declined. */
  rules: string[];
  /** Accessibility snapshot of the page at failure time (from error-context.md). */
  ariaSnapshot: string[] | null;
  trace: TraceSummary | { unavailable: string };
}

const CALL_LOG = /\n\s*Call log:/;
const MAX_ARIA_LINES = 60;

function errorPart(message: string): FailureContext['error'] {
  const [head, log = ''] = message.split(CALL_LOG);
  const callLog = [...new Set(log.split('\n').map((l) => l.trim().replace(/^-\s*/, '')).filter(Boolean))];
  return { message: truncate(head.trim(), 800), callLog: callLog.slice(0, 10).map((l) => truncate(l, 150)) };
}

function markdownBlock(markdown: string, heading: string): string[] | null {
  const block = markdown.match(new RegExp(`# ${heading}\\s*\`\`\`\\w*\\r?\\n([\\s\\S]*?)\`\`\``))?.[1];
  return block === undefined ? null : block.split(/\r?\n/).filter((l) => l.trim() !== '');
}

/**
 * Comments are removed from test code: in the synthetic suite they state the intended
 * failure outright, which would turn the eval into reading the answer key.
 */
function stripComment(line: string): string {
  return line.replace(/(^|\s)\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trimEnd();
}

function failingCode(markdown: string): string[] | null {
  const lines = markdownBlock(markdown, 'Test source');
  if (!lines) return null;
  const at = lines.findIndex((l) => /^>\s*\d+\s*\|/.test(l));
  const window = at < 0 ? lines : lines.slice(Math.max(0, at - 5), at + 4);
  return window
    .filter((l) => !/^\s*\|\s*\^/.test(l)) // caret line repeats the error message
    .map((l) => {
      const [gutter, ...code] = l.split('|');
      return `${gutter}|${stripComment(code.join('|'))}`;
    })
    .filter((l) => l.split('|')[1]?.trim());
}

function traceSummary(record: TriageRecord): FailureContext['trace'] {
  const rel = record.attachments.find((a) => a.name === 'trace')?.path;
  if (!rel) return { unavailable: 'no trace attached to this failure' };
  const file = join(PROJECT_ROOT, rel);
  if (!existsSync(file)) return { unavailable: 'trace file no longer on disk' };
  try {
    return summarizeTrace(file);
  } catch (error) {
    return { unavailable: `trace could not be read: ${truncate(String(error), 120)}` };
  }
}

export function buildFailureContext(record: TriageRecord, history: TestHistory, run: RunContext, rules: Diagnosis): FailureContext {
  const contextFile = errorContextPath(record);
  const markdown = contextFile ? readFileSync(contextFile, 'utf8') : '';
  const aria = markdownBlock(markdown, 'Page snapshot')?.map((l) => l.replace(/\s*\[ref=[^\]]+\]/g, '')) ?? null;
  const others = run.failures.filter((f) => f.testId !== record.testId);

  return {
    test: { id: record.testId, file: record.file, status: record.status, durationMs: record.duration, retry: record.retry },
    error: errorPart(record.errorMessage),
    failingCode: markdown ? failingCode(markdown) : null,
    history: {
      runs: history.runs,
      failures: history.failures,
      failureRatePct: Math.round(history.failureRate * 100),
      distinctErrors: history.distinctErrors,
      failingStreak: history.failingStreak,
      passesBeforeStreak: history.passesBeforeStreak,
      failuresBeforeStreak: history.failuresBeforeStreak,
    },
    run: {
      testsAttempted: run.testsAttempted,
      testsFailed: new Set(run.failures.map((f) => f.testId)).size,
      otherFailures: others.slice(0, 8).map((f) => `${f.testId}: ${truncate(errorShape(f.errorMessage), 100)}`),
    },
    rules: rules.evidence.map((e) => `[${e.source}] ${e.message}`),
    ariaSnapshot: aria ? aria.slice(0, MAX_ARIA_LINES) : null,
    trace: traceSummary(record),
  };
}
