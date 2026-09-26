// Phase 15: the evidence, as one artifact.
//
// Everything Tewip knows about a build is already written down - which tests ran, what each failure
// was, which rule or which person decided it, what it refused to decide, what it never looked at.
// It is scattered across reports that only a person watching CI ever reads.
//
// An attestation gathers it into one thing a release manager, an auditor or a colleague can read
// without opening CI at all. The part that makes it worth anything is the part competitors have no
// way to produce: the refusals. A tool that never says "I could not tell" has nothing to attest,
// because every line it writes might be a guess. Tewip's refusals are recorded, so they can be
// counted, and a bundle that lists what was *not* checked is a stronger claim about what was.
//
// The rule this file keeps: nothing enters a bundle that Tewip did not verify itself. Every claim
// names the run it came from, and anything undecided is stated as undecided rather than dropped.
import type { TriageRecord, RunSummary } from '../../reporters/types.ts';

export interface AttestedClaim {
  /** What is being claimed, in one line. */
  claim: string;
  /** How Tewip knows: the rule, the person, or the model that decided, and the evidence. */
  evidence: string;
  /** Which run it came from, so it can be traced back. */
  runId: string;
  /** rules | llm | person - who decided. A claim with no source is never written. */
  decidedBy: string;
  confidence: number;
}

export interface Refusal {
  what: string;
  why: string;
  runId: string;
}

export interface Attestation {
  project: string;
  /** The commit this describes, when the runner recorded one. */
  commit: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** Tests attempted in the run, from the runner's own count. */
  testsAttempted: number;
  failures: number;
  /** What Tewip checked, in the words of the check. */
  checked: string[];
  /** What it did not check. A bundle without this is a claim it cannot support. */
  notChecked: string[];
  claims: AttestedClaim[];
  refusals: Refusal[];
  /** Tewip's version and rule-engine version, so a bundle can be reproduced. */
  producedBy: { tool: string; engine: string; at: string };
}

const sourceOf = (record: TriageRecord): string => String((record.diagnosis as { source?: string } | undefined)?.source ?? '');

/** The evidence line a person reads: the first thing the deciding layer actually said. */
function evidenceOf(record: TriageRecord): string {
  const evidence = (record.diagnosis as { evidence?: Array<{ message?: string }> } | undefined)?.evidence ?? [];
  const first = evidence.find((e) => e.message)?.message ?? '';
  return first.slice(0, 300);
}

/**
 * The bundle for one run. `records` and `run` are what Tewip itself wrote when it read the report,
 * so everything here is traceable; nothing is inferred and nothing is re-judged.
 */
export function attestRun(
  project: string,
  run: RunSummary,
  records: TriageRecord[],
  { checked, notChecked, tool, engine }: { checked: string[]; notChecked: string[]; tool: string; engine: string },
): Attestation {
  const claims: AttestedClaim[] = [];
  const refusals: Refusal[] = [];

  for (const record of records) {
    const diagnosis = record.diagnosis as { category?: string; confidence?: number } | undefined;
    const category = diagnosis?.category ?? 'UNKNOWN';
    const decidedBy = sourceOf(record);
    // Undecided is not a claim. It is the refusal that makes the rest of the bundle believable.
    if (category === 'UNKNOWN' || !decidedBy) {
      refusals.push({
        what: `${record.testId} failed, and Tewip did not classify it`,
        why: evidenceOf(record) || 'no rule matched and the model was not asked or did not answer',
        runId: record.runId,
      });
      continue;
    }
    claims.push({
      claim: `${record.testId} failed because of ${category}`,
      evidence: evidenceOf(record) || 'no evidence recorded',
      runId: record.runId,
      decidedBy,
      confidence: Number(diagnosis?.confidence ?? 0),
    });
  }

  return {
    project,
    commit: run.gitSha ?? '',
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    testsAttempted: Object.keys(run.attempts ?? {}).length,
    failures: records.length,
    checked,
    notChecked,
    claims,
    refusals,
    producedBy: { tool, engine, at: new Date().toISOString() },
  };
}

/** The bundle as a person reads it. The refusals are not hidden at the bottom; they are the point. */
export function renderAttestation(a: Attestation): string {
  const when = a.finishedAt ? a.finishedAt.slice(0, 19).replace('T', ' ') : 'unknown';
  const lines = [
    `# What Tewip checked: ${a.project}`,
    '',
    `Run \`${a.runId}\`${a.commit ? ` at commit \`${a.commit.slice(0, 8)}\`` : ''}, finished ${when} UTC.`,
    `${a.testsAttempted} test(s) attempted, ${a.failures} failed.`,
    '',
    '## What was checked',
    '',
    ...(a.checked.length > 0 ? a.checked.map((c) => `- ${c}`) : ['- nothing: this bundle makes no claims']),
    '',
    '## What was NOT checked',
    '',
    ...(a.notChecked.length > 0
      ? a.notChecked.map((c) => `- ${c}`)
      : ['- nothing is recorded as unchecked, which is itself worth doubting: a check that was never run cannot report itself']),
    '',
  ];

  lines.push(`## Claims (${a.claims.length})`, '');
  if (a.claims.length === 0) lines.push('None: nothing failed, so there is nothing to explain.', '');
  for (const claim of a.claims) {
    lines.push(`- **${claim.claim}** — ${claim.decidedBy}, confidence ${claim.confidence.toFixed(2)}`);
    lines.push(`  - Evidence: ${claim.evidence}`);
    lines.push(`  - From run \`${claim.runId}\``);
  }

  lines.push('', `## Refused (${a.refusals.length})`, '');
  lines.push(
    a.refusals.length > 0
      ? 'Tewip could not decide these. They are listed because a tool that never says so cannot be trusted about the rest.'
      : 'Nothing was left undecided in this run.',
    '',
  );
  for (const refusal of a.refusals) {
    lines.push(`- **${refusal.what}**`);
    lines.push(`  - Why: ${refusal.why}`);
  }

  lines.push(
    '',
    '---',
    '',
    `Produced by ${a.producedBy.tool} (${a.producedBy.engine}) at ${a.producedBy.at.slice(0, 19).replace('T', ' ')} UTC.`,
    'Every claim above names the run it came from and the layer that decided it. This is a statement',
    'about the checks listed under "what was checked" and nothing else.',
  );
  return lines.join('\n');
}
