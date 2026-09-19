// The smart merge gate: fail the build on failures that need someone, let known noise through.
// Flaky-test products quarantine tests they have flagged so they stop blocking merges; this does
// the same per failure, from the diagnosis. It is conservative on purpose: only a deterministic
// rule's or a person's TIMING/ENV verdict counts as noise. An AI-only verdict, a low confidence,
// or anything undecided still blocks, because letting a real bug through costs far more than
// asking a person to look at a flaky test.
import { appendFileSync } from 'node:fs';
import type { TriageItem } from '../outlets/items.ts';

/** Below this, even a rule's TIMING/ENV verdict is not trusted to let a failure through. */
export const GATE_MIN_CONFIDENCE = 0.7;

export interface GateResult {
  blocking: TriageItem[];
  flaky: TriageItem[];
  environment: TriageItem[];
}

/** True when this failure is noise the gate may let through. */
export function isNoise(item: TriageItem): boolean {
  const d = item.diagnosis;
  const trusted = d.source === 'human' || (d.source === 'rules' && d.confidence >= GATE_MIN_CONFIDENCE);
  return trusted && (d.category === 'TIMING' || d.category === 'ENV');
}

export function gate(items: TriageItem[]): GateResult {
  return {
    blocking: items.filter((i) => !isNoise(i)),
    flaky: items.filter((i) => isNoise(i) && i.diagnosis.category === 'TIMING'),
    environment: items.filter((i) => isNoise(i) && i.diagnosis.category === 'ENV'),
  };
}

/** Writes the counts as step outputs, so later steps and workflows can act on them. */
export function writeGateOutputs(file: string | null, result: GateResult): void {
  if (!file) return;
  appendFileSync(file, `blocking=${result.blocking.length}\nflaky=${result.flaky.length}\nenvironment=${result.environment.length}\n`, 'utf8');
}

/** One line for the log saying what the gate decided and why. */
export function gateSummary(result: GateResult): string {
  const noise = result.flaky.length + result.environment.length;
  if (result.blocking.length === 0) {
    return noise === 0 ? 'gate: no failures' : `gate: passing - all ${noise} failure(s) are flaky (${result.flaky.length}) or environment (${result.environment.length}), classified by a rule or a person`;
  }
  const names = result.blocking.slice(0, 5).map((i) => `${i.title} (${i.diagnosis.category}${i.diagnosis.source === 'llm' ? ', AI only' : ''})`);
  return `gate: failing - ${result.blocking.length} failure(s) need someone: ${names.join('; ')}${result.blocking.length > 5 ? '; ...' : ''}${noise ? `. ${noise} other failure(s) are flaky or environment and do not block` : ''}`;
}
