// What the AI layer cost this process: calls, cache hits, tokens, time, and money - priced per
// model from OpenAI's published list, or from TRIAGE_LLM_PRICE_IN/OUT when set. Teams adopting an
// agent need to see its latency and cost, and to cap them, as much as its accuracy.
export interface Usage {
  calls: number;
  cacheHits: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  totalMs: number;
  /** Calls refused because the per-process budget was used up. */
  refused: number;
  /** Dollars spent on calls whose model has a known price. */
  costUsd: number;
  /** Calls to a model with no known price: the cost line then says it is incomplete. */
  unpriced: number;
}

const usage: Usage = { calls: 0, cacheHits: 0, failures: 0, promptTokens: 0, completionTokens: 0, totalMs: 0, refused: 0, costUsd: 0, unpriced: 0 };

/**
 * USD per million tokens (input, cached input, output), standard tier, from
 * https://developers.openai.com/api/docs/pricing as read on 2026-09-19. The first
 * matching prefix wins, so more specific names come first.
 */
const PRICES: Array<[prefix: string, input: number, cached: number, output: number]> = [
  ['gpt-5.6-astra', 10, 1, 50],
  ['gpt-5.6-sol', 4, 0.4, 20],
  ['gpt-5.6-terra', 2, 0.2, 12],
  ['gpt-5.6-luna', 0.2, 0.02, 1.2],
  ['gpt-5.5', 5, 0.5, 30],
  ['gpt-5.4-mini', 0.75, 0.075, 4.5],
  ['gpt-5.4-nano', 0.2, 0.02, 1.25],
  ['gpt-5.4', 2.5, 0.25, 15],
];

export const llmUsage = (): Usage => ({ ...usage });
export const resetLlmUsage = (): void => void Object.keys(usage).forEach((k) => (usage[k as keyof Usage] = 0));

export function recordCall(ms: number, tokens?: { prompt?: number; completion?: number; cached?: number }, model?: string): void {
  usage.calls++;
  usage.totalMs += ms;
  const prompt = tokens?.prompt ?? 0;
  const completion = tokens?.completion ?? 0;
  usage.promptTokens += prompt;
  usage.completionTokens += completion;
  const price = priceOf(model);
  if (!price) {
    usage.unpriced++;
    return;
  }
  const cached = Math.min(tokens?.cached ?? 0, prompt);
  usage.costUsd += ((prompt - cached) * price.in + cached * price.cached + completion * price.out) / 1_000_000;
}
export const recordCacheHit = (): void => void usage.cacheHits++;
export const recordFailure = (): void => void usage.failures++;
export const recordRefusal = (): void => void usage.refused++;

/** A team's own price (TRIAGE_LLM_PRICE_IN/OUT) wins; otherwise the published price of the model. */
export function priceOf(model?: string): { in: number; cached: number; out: number } | null {
  const input = Number(process.env.TRIAGE_LLM_PRICE_IN);
  const output = Number(process.env.TRIAGE_LLM_PRICE_OUT);
  if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) return { in: input, cached: input, out: output };
  const row = model ? PRICES.find(([prefix]) => model.startsWith(prefix)) : undefined;
  return row ? { in: row[1], cached: row[2], out: row[3] } : null;
}

/** Dollars spent, or null when no call had a known price. */
export function estimatedCostUsd(u: Usage = usage): number | null {
  return u.calls > u.unpriced ? u.costUsd : null;
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
    cost === null ? (u.calls ? 'cost: unknown model price, set TRIAGE_LLM_PRICE_IN/OUT' : 'cost: $0 (all from cache)') : `cost: ~$${cost.toFixed(4)}${u.unpriced ? ` plus ${u.unpriced} call(s) at an unknown price` : ''}`,
  ];
  if (u.failures) parts.push(`${u.failures} call(s) failed, kept the rules' answer`);
  if (u.refused) parts.push(`${u.refused} call(s) skipped: budget TRIAGE_LLM_MAX_CALLS reached`);
  return parts.join(' · ');
}
