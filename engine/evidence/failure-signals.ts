// What a classifier can see at the moment a test fails, and nothing it could only know later.
//
// Phase 56 asked, of 471 labelled failures from one project, how far each of these moves the label
// from its base rate. TIMING and ENV separate cleanly. REAL_BUG did not move at all - 3 to 6 per
// cent in every bucket - and that single column is why the model layer is capped below the
// escalation threshold and why `REAL_BUG` resting on nothing but a timeout is refused outright.
//
// The list lives here rather than inside the script that first used it because a second harness now
// asks the same question of every project, and two copies of a signal list is two answers to one
// question the first time somebody edits one of them.
//
// The constraint that makes these honest: each must be computable from the failure itself. Anything
// that needs the commit that later fixed the test is ground truth, not a signal - that information
// arrives days afterwards, which is Phase 56's actual finding about where the answer lives.
export interface FailureSignal {
  name: string;
  of: (error: string) => boolean;
}

/**
 * The two that turned out to carry REAL_BUG, exported by name because a rule now depends on them.
 *
 * One definition, used by the harness that measured the effect and by the rule that acts on it. Two
 * copies of "what counts as an assertion" is two answers the first time somebody edits one, and the
 * published figure would then describe a rule that no longer exists.
 */
export const isAssertion = (e: string): boolean => /\bexpect\(|toBe|toEqual|toHaveText|toMatch/i.test(e);
export const mentionsLocator = (e: string): boolean => /locator|getBy|selector/i.test(e);

export const SIGNALS: FailureSignal[] = [
  { name: 'error says Timeout/exceeded', of: (e) => /timeout|exceeded/i.test(e) },
  { name: 'error says "not visible"/"not enabled"/"not stable"', of: (e) => /not (visible|enabled|stable|attached)/i.test(e) },
  { name: 'error is an assertion (expect/toBe/toEqual)', of: isAssertion },
  { name: 'error says strict mode violation', of: (e) => /strict mode violation/i.test(e) },
  { name: 'error mentions a locator', of: mentionsLocator },
  { name: 'error says 4xx/5xx or network', of: (e) => /\b(4\d\d|5\d\d)\b|ECONN|ENOTFOUND|net::/i.test(e) },
];

/** A harvested record's error text, wherever this dataset's harvest put it. */
export const errorOf = (r: { error?: { message?: string }; errorMessage?: string }): string => r.error?.message ?? r.errorMessage ?? '';

/**
 * Wilson score interval for a proportion, at roughly 95%.
 *
 * Here because the question this answers is "does this signal move the rate", and with 7 cases a
 * rate of 57% and a rate of 12% are not distinguishable. Phase 179 found what looked like a strong
 * REAL_BUG signal on one project and it rested on 4 cases out of 7; reporting the interval is what
 * keeps that from becoming the next figure nobody checked.
 */
export function wilson(k: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - spread) / d), high: Math.min(1, (centre + spread) / d) };
}
