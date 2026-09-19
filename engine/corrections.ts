// LEARN step: what people told the agent it got wrong. A correction is a human's category for
// one failure, written where the agent posted its answer (a PR comment, an issue comment) as
// "/triage CATEGORY reason". It is stored with the run history and applied to later failures of
// the same test that fail the same way, so the agent does not repeat a mistake a person already
// corrected. Corrections decide the category only: they never authorise a code change on their
// own, because a person's category is not a verified replacement locator.
import { join } from 'node:path';
import type { Diagnosis, RootCause, TriageRecord } from '../reporters/types.ts';
import { ROOT_CAUSES } from '../reporters/types.ts';
import { appendJsonl, readJsonl } from '../reporters/store.ts';
import { errorShape, truncate } from './signature.ts';

export const CORRECTIONS_FILE = 'corrections.jsonl';

export interface Correction {
  schemaVersion: 1;
  testId: string;
  /** The error shape this correction was made for; a different failure of the test is not it. */
  errorShape: string;
  category: RootCause;
  /** GitHub login of the person who wrote it. */
  by: string;
  at: string;
  reason?: string;
  /** Where it was written, e.g. "PR #12 comment". */
  source?: string;
  /** What the agent had said, so the pair can be turned into a labelled example later. */
  wasCategory?: string;
}

const file = (dir: string) => join(dir, CORRECTIONS_FILE);

export const loadCorrections = (dir: string): Correction[] => readJsonl<Correction>(file(dir));

/** Appends corrections that are not already stored (same test, shape, category and author). */
export function saveCorrections(dir: string, corrections: Correction[]): Correction[] {
  const existing = loadCorrections(dir);
  const seen = new Set(existing.map((c) => `${c.testId}|${c.errorShape}|${c.category}|${c.by}`));
  const fresh = corrections.filter((c) => !seen.has(`${c.testId}|${c.errorShape}|${c.category}|${c.by}`));
  if (fresh.length > 0) appendJsonl(file(dir), fresh);
  return fresh;
}

/** The most recent correction for this test failing this way, if a person made one. */
export function correctionFor(record: TriageRecord, corrections: readonly Correction[]): Correction | null {
  const shape = errorShape(record.errorMessage);
  const matches = corrections.filter((c) => c.testId === record.testId && c.errorShape === shape);
  return matches.sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
}

/**
 * Applies a person's correction to a diagnosis. The category becomes theirs, at full confidence,
 * and the agent's own answer is kept as evidence so the disagreement stays visible.
 */
export function applyCorrection(diagnosis: Diagnosis, correction: Correction): Diagnosis {
  const said = `${diagnosis.category} at ${diagnosis.confidence.toFixed(2)}`;
  return {
    ...diagnosis,
    category: correction.category,
    confidence: 1,
    source: 'human',
    evidence: [
      {
        source: 'human',
        message: `@${correction.by} corrected this to ${correction.category}${correction.reason ? `: ${truncate(correction.reason, 160)}` : ''}${correction.source ? ` (${correction.source})` : ''}`,
        data: { correctedAt: correction.at, was: said },
      },
      ...diagnosis.evidence,
    ],
  };
}

const COMMAND = /(?:^|\s)\/triage\s+([A-Z_]+)\b[ \t]*(.*)$/gim;

export interface ParsedCorrection {
  category: RootCause;
  reason?: string;
  /** The board number the person referred to ("#3"), when they gave one. */
  item?: number;
  /** The suite named before the number ("unit#3"), when a workflow triages several suites. */
  suite?: string;
}

/**
 * Reads "/triage CATEGORY reason" commands out of a comment. A comment may correct several
 * failures, each line naming the board number it means: "/triage TIMING #3 flaky in CI".
 */
export function parseCorrectionCommands(body: string): ParsedCorrection[] {
  const out: ParsedCorrection[] = [];
  for (const [, word, rest] of body.matchAll(COMMAND)) {
    const category = ROOT_CAUSES.find((c) => c === word.toUpperCase());
    if (!category) continue;
    const ref = rest.match(/(?:^|\s)([\w.-]+)?#(\d+)/);
    const reason = (ref ? rest.replace(ref[0], ' ') : rest).trim();
    out.push({ category, reason: reason || undefined, item: ref ? Number(ref[2]) : undefined, ...(ref?.[1] ? { suite: ref[1] } : {}) });
  }
  return out;
}
