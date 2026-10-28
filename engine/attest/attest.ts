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
import { readFileSync } from 'node:fs';
import { seal, type Seal } from './seal.ts';

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
  /**
   * How many attempts of this test failed in the run. Retries are not separate claims - see
   * `oneClaimPerTest` - but they are not thrown away either: a test that failed every attempt and
   * one that failed once are different facts about the same run.
   */
  attempts: number;
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
  /** A digest of the content, and a signature when a key was available. */
  seal?: Seal;
}

const sourceOf = (record: TriageRecord): string => String((record.diagnosis as { source?: string } | undefined)?.source ?? '');

/**
 * One record per failing test, with the attempts counted.
 *
 * Phase 114. A retried test is written to the history once per attempt, and this file turned each
 * attempt into its own claim. In the worst real gutenberg run that is **492 claims about 164
 * failing tests**, each one repeated three times, under `failures: 492` - inside a signed bundle
 * whose entire purpose is to be a precise record somebody else can check. 50 of that project's 283
 * runs were affected.
 *
 * It was not only duplication. Where one attempt was decided and another was not, the same test
 * produced both a claim and a refusal: a signed document asserting a cause and disclaiming it at
 * once. So the attempt that carries a decision is the one kept, and a test is undecided here only
 * when no attempt of it was decided at all.
 */
function oneClaimPerTest(records: TriageRecord[]): Array<{ record: TriageRecord; attempts: number }> {
  const byTest = new Map<string, { record: TriageRecord; attempts: number }>();
  for (const record of records) {
    const already = byTest.get(record.testId);
    if (!already) {
      byTest.set(record.testId, { record, attempts: 1 });
      continue;
    }
    already.attempts += 1;
    const decided = (r: TriageRecord): boolean => {
      const category = (r.diagnosis as { category?: string } | undefined)?.category;
      return Boolean(category) && category !== 'UNKNOWN' && Boolean(sourceOf(r));
    };
    if (!decided(already.record) && decided(record)) already.record = record;
  }
  return [...byTest.values()];
}

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
  {
    checked,
    notChecked,
    tool,
    engine,
    refusals: given = [],
  }: { checked: string[]; notChecked: string[]; tool: string; engine: string; refusals?: Refusal[] },
): Attestation {
  const claims: AttestedClaim[] = [];
  // Refusals the caller already established - a test in this change that cannot fail, for instance -
  // belong here beside the ones the records produce. They are the same kind of statement: something
  // this bundle will not vouch for.
  const refusals: Refusal[] = [...given];

  const perTest = oneClaimPerTest(records);
  for (const { record, attempts } of perTest) {
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
      attempts,
    });
  }

  const bundle = {
    project,
    commit: run.gitSha ?? '',
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    testsAttempted: Object.keys(run.attempts ?? {}).length,
    // Failing tests, not failure records. This read 492 for a run in which 164 tests failed.
    failures: perTest.length,
    checked,
    notChecked,
    claims,
    refusals,
    producedBy: { tool, engine, at: new Date().toISOString() },
  };
  // Sealed last, over everything above: the digest is of the content, never of itself.
  return { ...bundle, seal: seal(bundle, signingKey()) };
}

/** The Ed25519 private key to sign with, from TEWIP_ATTEST_KEY: a PEM, or a path to one. */
function signingKey(): string | undefined {
  const given = process.env.TEWIP_ATTEST_KEY?.trim();
  if (!given) return undefined;
  if (given.includes('BEGIN')) return given;
  try {
    return readFileSync(given, 'utf8');
  } catch (error) {
    throw new Error(`TEWIP_ATTEST_KEY points at ${given}, which could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    a.seal?.signature
      ? `Signed (${a.seal.algorithm}); digest ${a.seal.digest.slice(0, 16)}…. Check it with \`tewip attest --verify <bundle.json> --key <public.pem>\`.`
      : a.seal
        ? `Digest ${a.seal.digest.slice(0, 16)}…, which is not a signature: it shows the bundle is undamaged, not that nobody edited it. Set TEWIP_ATTEST_KEY to sign.`
        : '',
    'Every claim above names the run it came from and the layer that decided it. This is a statement',
    'about the checks listed under "what was checked" and nothing else.',
  );
  return lines.join('\n');
}
