// Phase 31: reading a Lighthouse report.
//
// k6 measures what a server does under load. Lighthouse measures what one page load costs in a real
// browser - Largest Contentful Paint, layout shift, blocking time - which is nearer to what a person
// actually waits for, and is what most teams already run. Tewip could read neither until now.
//
// The same discipline as everywhere else applies, and Lighthouse needs it more than k6 does. Four
// real Lighthouse runs of an unchanged page, measured here, gave LCP of 922, 912, 936 and 916ms: a
// 2.6% spread from nothing happening. Lighthouse's own score moved between runs too. So the
// comparison is the same one k6 gets - outside the baseline range by more than its own width, with
// three baselines required before anything is called at all.
//
// One thing is deliberately not invented. "Is 2112ms bad?" has a published answer, and it is
// Google's, not Tewip's: Lighthouse scores every metric 0 to 1 on its own curve and renders the
// bands at 0.9 and 0.5. Tewip reads that score rather than hard-coding thresholds it remembered,
// so the word "poor" in a report is Lighthouse's judgement and is traceable to it.
import { readFileSync } from 'node:fs';
import type { ComparableRun, Metric } from './run.ts';

/** The audits worth comparing between runs: what the page load cost, not advice about it. */
const MEASURED = new Set([
  'largest-contentful-paint',
  'first-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
  'interaction-to-next-paint',
  'server-response-time',
  'time-to-first-byte',
]);

/** Lighthouse renders green at 0.9 and orange at 0.5. The bands are its own, and so is the word. */
function rating(score: unknown): Metric['rating'] {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score >= 0.9) return 'good';
  if (score >= 0.5) return 'needs-improvement';
  return 'poor';
}

interface Audit {
  id?: unknown;
  score?: unknown;
  scoreDisplayMode?: unknown;
  numericValue?: unknown;
  numericUnit?: unknown;
  title?: unknown;
  details?: unknown;
}

/** An accessibility audit a person has to judge, which Lighthouse marks rather than scoring. */
export interface ManualCheck {
  id: string;
  title: string;
}

export interface LighthouseReport {
  run: ComparableRun;
  /** The overall category scores, 0 to 1, as Lighthouse computed them. */
  categories: Record<string, number>;
  /**
   * Accessibility audits Lighthouse scored as failed. These are axe rules underneath, so they are
   * named by their axe rule id and can be triaged the same way Phase 29 triages an axe run.
   */
  accessibilityFailures: Array<{ id: string; title: string; selector: string; snippet: string; explanation: string }>;
  /**
   * Audits Lighthouse explicitly refuses to score and hands to a person: logical tab order, focus
   * traps, visual order following the DOM. Tewip reports them as questions, which is what they are,
   * and never as passes - a page with no failures and nine unanswered manual checks is not a page
   * that passed.
   */
  manual: ManualCheck[];
  /**
   * Every accessibility audit that ran, whatever its outcome - passing and not-applicable included.
   * Both are evidence the rule was checked, which is what lets a Lighthouse run move contrast off
   * the list of things Tewip says it could not look at (Phase 32).
   */
  accessibilityAuditIds: string[];
  url: string;
  lighthouseVersion: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function looksLikeLighthouse(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.lighthouseVersion === 'string' && typeof o.audits === 'object' && o.audits !== null;
}

/** The nodes a failing accessibility audit points at. */
function failingNodes(audit: Audit): Array<{ selector: string; snippet: string; explanation: string }> {
  const details = (audit.details ?? {}) as Record<string, unknown>;
  const items = Array.isArray(details.items) ? details.items : [];
  const out: Array<{ selector: string; snippet: string; explanation: string }> = [];
  for (const item of items) {
    const node = ((item as Record<string, unknown>)?.node ?? {}) as Record<string, unknown>;
    out.push({
      selector: text(node.selector),
      snippet: text(node.snippet).replace(/\s+/g, ' ').slice(0, 160),
      explanation: text(node.explanation)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !/^Fix (any|all) of the following:$/.test(l))
        .join('; '),
    });
  }
  return out;
}

export function readLighthouse(path: string): LighthouseReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not JSON. Tewip reads the JSON Lighthouse writes with --output=json.`);
  }
  if (!looksLikeLighthouse(parsed)) {
    throw new Error(
      `${path} is JSON, but not a Lighthouse report: Tewip looked for "lighthouseVersion" and an "audits" object. ` +
        'Write one with: lighthouse <url> --output=json --output-path=report.json',
    );
  }
  const o = parsed as Record<string, unknown>;

  // A report can carry a runtime error and still be valid JSON with empty audits. Reporting "no
  // regression" from a run that never loaded the page would be the worst kind of wrong.
  const runtimeError = (o.runtimeError ?? null) as Record<string, unknown> | null;
  if (runtimeError && text(runtimeError.code) !== 'NO_ERROR' && text(runtimeError.message) !== '') {
    throw new Error(`that Lighthouse run did not complete: ${text(runtimeError.message)}`);
  }

  const audits = (o.audits ?? {}) as Record<string, Audit>;
  const categories = (o.categories ?? {}) as Record<string, { score?: unknown }>;

  const metrics: Record<string, Metric> = {};
  for (const [id, audit] of Object.entries(audits)) {
    if (!MEASURED.has(id) || typeof audit.numericValue !== 'number') continue;
    metrics[id] = {
      value: num(audit.numericValue),
      unit: audit.numericUnit === 'millisecond' ? 'ms' : 'unitless',
      rating: rating(audit.score),
    };
  }
  // The category score itself is worth tracking: it is the number teams quote at each other.
  for (const [name, category] of Object.entries(categories)) {
    if (typeof category?.score === 'number') {
      metrics[`${name}-score`] = { value: category.score, unit: 'score', rating: rating(category.score) };
    }
  }

  const accessibilityFailures: LighthouseReport['accessibilityFailures'] = [];
  const manual: ManualCheck[] = [];
  const accessibilityAuditIds: string[] = [];
  const a11yRefs = ((categories.accessibility as Record<string, unknown> | undefined)?.auditRefs ?? []) as Array<{ id?: unknown }>;
  for (const ref of a11yRefs) {
    const audit = audits[text(ref.id)];
    if (!audit) continue;
    const id = text(audit.id);
    // Recorded before the outcome is looked at: a rule that passed, or did not apply to this page,
    // has still been checked, and that is what coverage means.
    if (id !== '') accessibilityAuditIds.push(id);
    if (audit.scoreDisplayMode === 'manual') {
      manual.push({ id, title: text(audit.title) });
      continue;
    }
    if (typeof audit.score === 'number' && audit.score < 1) {
      const nodes = failingNodes(audit);
      if (nodes.length === 0) accessibilityFailures.push({ id, title: text(audit.title), selector: '', snippet: '', explanation: '' });
      for (const node of nodes) accessibilityFailures.push({ id, title: text(audit.title), ...node });
    }
  }

  return {
    run: {
      source: 'lighthouse',
      at: text(o.fetchTime) || new Date().toISOString(),
      metrics,
      // Lighthouse has no user-written thresholds the way a k6 script does. That is an absence of
      // the feature, not an export that forgot to record them, so an empty list is the honest value.
      thresholds: [],
      volume: { kind: 'page load', n: 1 },
    },
    categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, num(v?.score)])),
    accessibilityFailures,
    manual,
    accessibilityAuditIds,
    url: text(o.finalDisplayedUrl) || text(o.finalUrl) || text(o.requestedUrl),
    lighthouseVersion: text(o.lighthouseVersion),
  };
}

/** True of a Lighthouse report, for a command that accepts either tool's output. */
export function isLighthouseFile(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return looksLikeLighthouse(parsed);
  } catch {
    return false;
  }
}
