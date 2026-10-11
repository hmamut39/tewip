// Phase 32: a Lighthouse report, read as accessibility evidence.
//
// Lighthouse's accessibility audits are axe rules running inside Lighthouse - the ids are the same -
// so everything Phase 29 learned about triaging an axe run applies, once the missing half is
// supplied. The missing half is the tags: a live axe run labels every rule `wcag143`, `EN-9.1.4.3`
// and so on, and a Lighthouse report carries none of that. Without it `landmark-one-main` is just a
// name, and Tewip cannot tell a failure of a legal standard from one of axe's own suggestions -
// which is the distinction the whole command is built on, and which covers 30 of axe's 105 rules.
//
// axe-rules.ts supplies it, generated from axe-core rather than remembered.
//
// One thing Lighthouse does not report and is not invented here: impact. A live axe run says
// `critical` or `moderate`; Lighthouse says nothing. So severity comes from the WCAG conformance
// level instead, which is real data and is the standard's own ordering of how basic a requirement
// is - and the report says that is where it came from.
import type { Severity } from './wcag.ts';
import type { BrowserFinding } from './reports.ts';
import { factsFor } from './axe-rules.ts';
import type { LighthouseReport } from '../perf/lighthouse.ts';

/** WCAG's own ordering: level A is the most basic requirement, so its failures come first. */
const BY_LEVEL: Record<string, Severity> = { A: 'blocker', AA: 'serious', AAA: 'moderate' };

/**
 * The accessibility half of a Lighthouse report, as findings the Phase 29 report can print.
 *
 * Three kinds come out, the same three an axe run produces:
 *   - a failing audit whose rule tests a WCAG criterion  -> a barrier;
 *   - a failing audit whose rule tests nobody's standard -> advice;
 *   - an audit Lighthouse marks `manual`                 -> a question, because Lighthouse itself
 *     declines to answer it. Those are not passes, and a page with no failures and ten unanswered
 *     manual checks has not passed.
 */
export function accessibilityFromLighthouse(report: LighthouseReport): BrowserFinding[] {
  const out: BrowserFinding[] = [];
  const page = report.url;

  for (const failure of report.accessibilityFailures) {
    const facts = factsFor(failure.id);
    const criterion = facts?.criterion ?? null;
    out.push({
      rule: failure.id,
      tool: 'axe',
      confidence: criterion === null ? 'advice' : 'barrier',
      criterion,
      level: facts?.level ?? null,
      en301549: facts?.en301549 ?? null,
      severity: criterion === null ? 'minor' : (BY_LEVEL[facts?.level ?? 'A'] ?? 'serious'),
      html: failure.snippet,
      selector: failure.selector,
      page,
      why: failure.title,
      next: failure.explanation || failure.title,
    });
  }

  for (const check of report.manual) {
    const facts = factsFor(check.id);
    out.push({
      rule: check.id,
      tool: 'axe',
      confidence: 'ask-a-person',
      criterion: facts?.criterion ?? null,
      level: facts?.level ?? null,
      en301549: facts?.en301549 ?? null,
      severity: 'moderate',
      html: '',
      selector: '',
      page,
      why: `${check.title}. Lighthouse does not score this one and hands it to a person`,
      next: 'check it yourself, ideally with a keyboard and a screen reader; it is neither a pass nor a failure until somebody looks',
    });
  }

  return out;
}

/**
 * Which axe rules a Lighthouse run actually exercised.
 *
 * Everything in the accessibility category ran, including the audits that passed and the ones that
 * did not apply to this page - both are evidence the rule was checked. This is what lets a
 * Lighthouse run move contrast off the "not checked" list, exactly as an axe run does, since
 * `color-contrast` is one of the rules it runs.
 */
export function rulesRunByLighthouse(report: LighthouseReport): Set<string> {
  return new Set(report.accessibilityAuditIds);
}

/** The criteria those rules test, for shrinking what the report has to call unchecked. */
export function criteriaFromLighthouse(report: LighthouseReport): Set<string> {
  const out = new Set<string>();
  for (const id of report.accessibilityAuditIds) {
    const criterion = factsFor(id)?.criterion;
    if (criterion) out.add(criterion);
  }
  return out;
}
