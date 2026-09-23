// What the corrections add up to.
//
// One correction is a disagreement. Twenty corrections are a map of where Tewip is systematically
// wrong, and that is worth more than any of them individually: it says which rule to change, or
// which prompt, rather than leaving a team to re-enter the same correction every week.
//
// Two rules keep this honest. It never claims a pattern from one or two cases - "you corrected this
// twice" is not evidence of anything, and saying so would be exactly the kind of confident noise
// this project exists to avoid. And it never proposes a rule it cannot point at: every claim names
// the failures it came from, so a person can read them and disagree.
import type { Correction } from '../corrections.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { errorShape, truncate } from '../signature.ts';
import type { VerdictCorrection } from './verdicts.ts';

/** Below this many corrections of the same shape, Tewip says "not yet", not "a pattern". */
export const ENOUGH_FOR_A_PATTERN = 3;

export interface Mistake {
  /** What Tewip said, and what people said instead. */
  said: string;
  corrected: string;
  count: number;
  /** How many *different* tests those corrections came from. Six corrections of one flaky test are
   * not six pieces of evidence, and a report that hides that is misleading. */
  tests: number;
  /** Which layers produced the wrong answers, with how many each: "rules 5, AI 2". */
  from: string;
  /** The rules that decided them, commonest first. */
  rules: Array<{ rule: string; count: number }>;
  /** The one rule behind most of them, when there is one. This is the thing to go and read. */
  rule: string;
  /** What those failures had in common, in their own words. */
  common: string[];
  /** Up to three of them, so a person can read the real thing. */
  examples: Array<{ testId: string; error: string; why: string }>;
}

export interface Learning {
  /** Corrections of a diagnosis, which are the ones that can be studied against the evidence. */
  diagnoses: number;
  /** Corrections of the other verdicts, counted by kind. */
  others: Array<{ kind: string; count: number }>;
  /** People who have corrected something. */
  people: string[];
  from: string;
  to: string;
  /** How many diagnoses were made in the same period, so the corrections have a denominator. */
  decisions: number;
  mistakes: Mistake[];
  /** What is true but not yet enough to act on. */
  notYet: string[];
}

const words = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !COMMON.has(w));
const COMMON = new Set(['error', 'expected', 'received', 'test', 'failed', 'failure', 'value', 'string', 'object', 'null', 'undefined', 'true', 'false', 'with', 'from', 'this', 'that', 'have', 'been', 'were', 'when', 'then', 'there', 'timeout', 'waiting']);

/** The words most of these failures share, which is the closest thing to "what they have in common". */
function sharedWords(errors: string[], min = 0.6): string[] {
  if (errors.length === 0) return [];
  const counts = new Map<string, number>();
  for (const error of errors) for (const w of new Set(words(error))) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n / errors.length >= min && n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);
}

/**
 * Which rule decided this. The diagnosis carries the winning rule as `ruleId`; older records only
 * have the evidence, whose first entry is named after the rule that produced it. Reading only the
 * evidence was a real bug here: every group came back "decided by 2 different layers, no rule",
 * which is the least useful thing this report could say.
 */
function ruleOf(record: TriageRecord | undefined): string {
  const diagnosis = record?.diagnosis as { ruleId?: string; evidence?: Array<{ source?: string }> } | undefined;
  if (diagnosis?.ruleId) return diagnosis.ruleId;
  for (const e of diagnosis?.evidence ?? []) if (e.source && e.source !== 'engine' && e.source !== 'llm') return e.source;
  return '';
}

const layerOf = (record: TriageRecord | undefined): string => String((record?.diagnosis as { source?: string } | undefined)?.source ?? 'unknown');

/** "rules 5, llm 2" - said in full, because "2 different layers" tells a person nothing. */
function countBy<T>(items: T[], of: (item: T) => string): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = of(item);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/**
 * Three failures to read. Different tests where possible: three copies of one flaky test look like
 * evidence and are not - they are one failure counted three times.
 */
function pickExamples(group: Correction[], errors: string[]): Mistake['examples'] {
  const seen = new Set<string>();
  const distinct: number[] = [];
  for (const [i, correction] of group.entries()) {
    if (seen.has(correction.testId)) continue;
    seen.add(correction.testId);
    distinct.push(i);
  }
  // Only distinct tests: how often each was corrected is already in the count above, and printing
  // one failure three times makes a single flaky test look like three findings.
  return distinct.slice(0, 3).map((i) => ({
    testId: group[i].testId,
    error: truncate((errors[i] ?? '').replace(/\s+/g, ' '), 140),
    why: group[i].reason ?? '',
  }));
}

/**
 * What the corrections say about Tewip, given the failures they were made on. `records` are the
 * runs Tewip kept, so each correction can be read against the evidence it was disagreeing with.
 */
export function whatWeLearned(corrections: Correction[], verdicts: VerdictCorrection[], records: TriageRecord[], decisions = records.length): Learning {
  const byShape = new Map<string, TriageRecord>();
  for (const record of records) byShape.set(`${record.testId}::${errorShape(record.errorMessage)}`, record);

  const groups = new Map<string, Correction[]>();
  for (const correction of corrections) {
    const key = `${correction.wasCategory ?? 'unknown'} -> ${correction.category}`;
    groups.set(key, [...(groups.get(key) ?? []), correction]);
  }

  const mistakes: Mistake[] = [];
  const notYet: string[] = [];
  for (const [key, group] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const [said, corrected] = key.split(' -> ');
    const found = group.map((c) => byShape.get(`${c.testId}::${c.errorShape}`));
    const errors = group.map((c, i) => found[i]?.errorMessage ?? c.errorShape);
    if (group.length < ENOUGH_FOR_A_PATTERN) {
      notYet.push(`${group.length} correction(s) turned ${said} into ${corrected}. That is not yet enough to call it a pattern; ${ENOUGH_FOR_A_PATTERN} of the same shape would be.`);
      continue;
    }
    const layers = countBy(found, layerOf);
    const rules = countBy(found, ruleOf);
    // One rule behind most of them is a rule to go and read; a scatter of rules is not.
    const main = rules[0] && rules[0].count / group.length >= 0.5 ? rules[0].name : '';
    mistakes.push({
      said,
      corrected,
      count: group.length,
      tests: new Set(group.map((c) => c.testId)).size,
      from: layers.map((l) => `${l.name} ${l.count}`).join(', ') || 'unknown',
      rules: rules.map((r) => ({ rule: r.name, count: r.count })),
      rule: main,
      common: sharedWords(errors),
      examples: pickExamples(group, errors),
    });
  }

  const byKind = new Map<string, number>();
  for (const v of verdicts) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
  const times = [...corrections.map((c) => c.at), ...verdicts.map((v) => v.at)].sort();

  return {
    diagnoses: corrections.length,
    others: [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    people: [...new Set([...corrections.map((c) => c.by), ...verdicts.map((v) => v.by)])].filter(Boolean),
    from: times[0] ?? '',
    to: times.at(-1) ?? '',
    decisions,
    mistakes,
    notYet,
  };
}

/** The report a person reads, and the one whose suggestions a person has to agree with. */
export function renderLearning(learned: Learning): string {
  const lines = ['# What your corrections say', ''];
  if (learned.diagnoses === 0 && learned.others.length === 0) {
    return [
      '# What your corrections say',
      '',
      'Nothing yet: nobody has corrected anything here.',
      '',
      'When Tewip gets something wrong, tell it - `tewip correct diagnosis "<test>" TIMING "why"` - and',
      'this report will say where it is systematically wrong, so the rule can be fixed rather than the',
      'same correction entered every week.',
    ].join('\n');
  }

  const period = learned.from ? `${learned.from.slice(0, 10)} to ${learned.to.slice(0, 10)}` : 'so far';
  const share = learned.decisions > 0 ? ` of ${learned.decisions} diagnoses kept here, which is ${((learned.diagnoses / learned.decisions) * 100).toFixed(1)}%` : '';
  lines.push(`${learned.diagnoses} diagnosis correction(s)${share}, ${period}.`);
  if (learned.others.length > 0) lines.push(`Other verdicts corrected: ${learned.others.map((o) => `${o.count} ${o.kind}`).join(', ')}.`);
  if (learned.people.length > 0) lines.push(`Corrected by: ${learned.people.join(', ')}.`);
  lines.push('');

  if (learned.mistakes.length === 0) {
    lines.push('No pattern yet.', '');
    for (const note of learned.notYet) lines.push(`- ${note}`);
    lines.push('', 'A handful of disagreements is not a fault to fix. This report gets useful as they add up.');
    return lines.join('\n');
  }

  lines.push('## Where Tewip is wrong in the same way, more than once', '');
  for (const mistake of learned.mistakes) {
    lines.push(`### ${mistake.count}× said ${mistake.said}, you said ${mistake.corrected}`, '');
    lines.push(`- From ${mistake.tests === 1 ? 'a single test' : `${mistake.tests} different tests`}${mistake.tests === 1 ? " - all of these corrections are the same test, so this may be a problem with that one test rather than with a rule" : ''}`);
    lines.push(`- Decided by: ${mistake.from}`);
    if (mistake.rules.length > 0) lines.push(`- Rules that decided them: ${mistake.rules.map((r) => `\`${r.rule}\` ${r.count}×`).join(', ')}`);
    if (mistake.common.length > 0) lines.push(`- Those failures all mention: ${mistake.common.join(', ')}`);
    lines.push('- The failures themselves:');
    for (const example of mistake.examples) lines.push(`  - **${example.testId}** — ${example.error}${example.why ? ` (you said: ${example.why})` : ''}`);
    lines.push('');
    const topRule = mistake.rules[0];
    lines.push(
      mistake.rule
        ? `What to do: read \`${mistake.rule}\` against those failures - it decided ${topRule.count} of ${mistake.count}. If it is matching something it should not, narrow it; if a rule for ${mistake.corrected} should have matched first, order that one first.`
        : topRule
          ? `What to do: no single rule is behind these - ${mistake.rules.length} different ones are, the commonest being \`${topRule.rule}\` (${topRule.count} of ${mistake.count}). That points at a missing rule for ${mistake.corrected} rather than a wrong one: the words above are what it would match on.`
          : `What to do: no rule decided these, so the model was left to answer them. A rule for ${mistake.corrected} matching the words above would settle them without asking it.`,
    );
    lines.push('');
  }
  for (const note of learned.notYet) lines.push(`- ${note}`);
  lines.push('');
  lines.push('Every line above comes from failures you corrected; nothing here is inferred from anything else.');
  return lines.join('\n');
}

/** The corrections as labelled examples, for measuring a change to the rules against real data. */
export function asLabels(corrections: Correction[]): string {
  return corrections
    .map((c) => JSON.stringify({ testId: c.testId, category: c.category, was: c.wasCategory, by: c.by, at: c.at, reason: c.reason ?? '', source: 'tewip correct' }))
    .join('\n');
}
