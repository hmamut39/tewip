// What the AI layer cost this process: calls, cache hits, tokens, time, and (only when prices
// are configured) money. Accuracy and safety were already measured; teams adopting an agent also
// need to see its latency and cost, and to cap them.
export interface Usage {
  calls: number;
  cacheHits: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  totalMs: number;
  /** Calls refused because the per-process budget was used up. */
  refused: number;
}

const usage: Usage = { calls: 0, cacheHits: 0, failures: 0, promptTokens: 0, completionTokens: 0, totalMs: 0, refused: 0 };

export const llmUsage = (): Usage => ({ ...usage });
export const resetLlmUsage = (): void => void Object.keys(usage).forEach((k) => (usage[k as keyof Usage] = 0));

export function recordCall(ms: number, tokens?: { prompt?: number; completion?: number }): void {
  usage.calls++;
  usage.totalMs += ms;
  usage.promptTokens += tokens?.prompt ?? 0;
  usage.completionTokens += tokens?.completion ?? 0;
}
export const recordCacheHit = (): void => void usage.cacheHits++;
export const recordFailure = (): void => void usage.failures++;
export const recordRefusal = (): void => void usage.refused++;

/** USD per million tokens, from TRIAGE_LLM_PRICE_IN / TRIAGE_LLM_PRICE_OUT. Unset: no cost line. */
function prices(): { in: number; out: number } | null {
  const input = Number(process.env.TRIAGE_LLM_PRICE_IN);
  const output = Number(process.env.TRIAGE_LLM_PRICE_OUT);
  return Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0) ? { in: input, out: output } : null;
}

export function estimatedCostUsd(u: Usage = usage): number | null {
  const p = prices();
  return p ? (u.promptTokens * p.in + u.completionTokens * p.out) / 1_000_000 : null;
}

/** One line for a report or job summary. Says "no AI calls" rather than printing zeros. */
export function usageLine(u: Usage = llmUsage()): string {
  if (u.calls === 0 && u.cacheHits === 0) return 'AI layer: no calls (rules only)';
  const seconds = (u.totalMs / 1000).toFixed(1);
  const perCall = u.calls > 0 ? ` (${Math.round(u.totalMs / u.calls)} ms each)` : '';
  const tokens = `${u.promptTokens.toLocaleString('en-US')} in / ${u.completionTokens.toLocaleString('en-US')} out tokens`;
  const cost = estimatedCostUsd(u);
  const parts = [
    `AI layer: ${u.calls} call(s) in ${seconds}s${perCall}`,
    `${u.cacheHits} cache hit(s)`,
    tokens,
    cost === null ? 'cost: set TRIAGE_LLM_PRICE_IN/OUT to estimate' : `cost: ~$${cost.toFixed(4)}`,
  ];
  if (u.failures) parts.push(`${u.failures} call(s) failed, kept the rules' answer`);
  if (u.refused) parts.push(`${u.refused} call(s) skipped: budget TRIAGE_LLM_MAX_CALLS reached`);
  return parts.join(' · ');
}
