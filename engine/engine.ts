// Phase-2 diagnosis engine: runs every rule, lets the highest-priority match decide, and
// marks anything no rule can decide as UNKNOWN (confidence 0) for the phase-3 LLM layer.
import type { Diagnosis, Evidence, TriageRecord } from '../reporters/types.ts';
import type { HistoryIndex } from './history.ts';
import { RULES, type Rule, type RuleInput, type RuleOutcome } from './rules.ts';
import { readPageSnapshot } from './snapshot.ts';
import { summarizeTrace } from './trace/trace-summary.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../reporters/store.ts';

/** Bump whenever a rule or threshold changes, so stored diagnoses can be recomputed. */
export const ENGINE_VERSION = 'rules-9';

/** Subtracted when rules disagree on the category, so the decision is less likely to trigger an autonomous action. */
const CONFLICT_PENALTY = 0.1;

const round2 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;

function evaluate(rule: Rule, input: RuleInput): RuleOutcome | null {
  try {
    return rule.evaluate(input);
  } catch (error) {
    return { category: null, confidence: 0, evidence: [{ source: rule.id, message: `rule crashed: ${String(error)}` }] };
  }
}

export function diagnose(input: RuleInput, now = new Date()): Diagnosis {
  const base = { source: 'rules', engineVersion: ENGINE_VERSION, diagnosedAt: now.toISOString() } as const;
  const outcomes = RULES.map((rule) => ({ rule, outcome: evaluate(rule, input) })).filter(
    (x): x is { rule: Rule; outcome: RuleOutcome } => x.outcome !== null,
  );
  const matches = outcomes.filter((x) => x.outcome.category !== null);

  if (matches.length === 0) {
    // Narrowest rules first: their notes say the most about this particular failure.
    const notes = outcomes.flatMap((x) => x.outcome.evidence).reverse();
    return {
      ...base,
      category: 'UNKNOWN',
      confidence: 0,
      evidence: notes.length > 0 ? notes : [{ source: 'engine', message: 'no rule applies to this kind of failure' }],
    };
  }

  const [winner, ...others] = matches;
  const evidence: Evidence[] = [...winner.outcome.evidence];
  let confidence = winner.outcome.confidence;
  const conflicts = others.filter((x) => x.outcome.category !== winner.outcome.category);
  if (conflicts.length > 0) {
    confidence -= CONFLICT_PENALTY;
    const list = conflicts.map((x) => `${x.rule.id} → ${x.outcome.category}`).join(', ');
    evidence.push({ source: 'engine', message: `lower-priority rules disagree (${list}); confidence lowered by ${CONFLICT_PENALTY}` });
  }
  evidence.push(...others.filter((x) => x.outcome.category === winner.outcome.category).flatMap((x) => x.outcome.evidence));

  return { ...base, category: winner.outcome.category!, confidence: round2(confidence), ruleId: winner.rule.id, evidence };
}

/** Requests that failed during one attempt, from its trace; [] when there is no readable trace. */
function failedRequestsOfAttempt(record: TriageRecord): Array<{ url: string; status: number | null }> {
  const rel = record.attachments.find((a) => a.name === 'trace')?.path;
  if (!rel || !existsSync(join(PROJECT_ROOT, rel))) return [];
  try {
    return summarizeTrace(join(PROJECT_ROOT, rel)).network.failed;
  } catch {
    return [];
  }
}

/**
 * Requests that failed during this test in this run, across every attempt. A retry often
 * succeeds in reaching a dependency that failed the first time, and only one attempt's trace
 * carries the failure; a person triaging looks at all of them, so the rules do too.
 */
function failedRequestsOf(record: TriageRecord, attempts: readonly TriageRecord[] = []): Array<{ url: string; status: number | null }> {
  const all = [record, ...attempts.filter((a) => a !== record)];
  return all.flatMap(failedRequestsOfAttempt);
}

/** Diagnoses `targets` using the point-in-time history held by `index`. */
export function diagnoseRecords(targets: TriageRecord[], index: HistoryIndex, now = new Date()): Diagnosis[] {
  return targets.map((record) =>
    diagnose(
      {
        record,
        history: index.historyAsOf(record.testId, record.runId),
        run: index.runContext(record.runId),
        loadSnapshot: () => readPageSnapshot(record),
        loadFailedRequests: () => failedRequestsOf(record, index.runContext(record.runId).failures.filter((f) => f.testId === record.testId)),
      },
      now,
    ),
  );
}
