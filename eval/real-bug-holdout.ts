// Which population are you measuring, and would widening the last-resort rule help?
//
// `real-bug-signal.ts --residue` reports 148 cases the rules refuse at a 41% REAL_BUG base rate,
// and finds two signals that move it: the error being an assertion, and the error naming no
// locator. Read on its own that looks like an unclaimed gain. It is not, and the reason is the
// population.
//
// `diagnosePipeline` contains `lastResortDiagnosis`, so a failure that rule catches comes back
// categorised REAL_BUG and is no longer UNKNOWN. The residue measured through the pipeline is
// therefore the residue **after that rule has already taken its 27 best cases** - and those 27 are
// precisely the assertion-and-no-locator ones. Measuring those two signals there is measuring them
// in a population from which they have been removed, and the "gain" is the shadow of the rule that
// already exists.
//
// Measured both ways, the difference is not subtle. On the depleted set an assertion error looks
// like it reverses on held-out data (+14.4 points tuned, -10.5 held out). On the population the
// rule would actually be selected on, it carries +22 points with the locator signal held fixed, and
// the rule's documented 27 of 27 re-derives exactly. A conclusion about a rule has to be drawn on
// the cases that rule would see.
//
// So this harness reconstructs that population - UNKNOWN plus whatever `last-resort-assertion`
// claimed - and asks the only question left: the rule is 27 of 27, so would dropping its narrower
// clause buy anything?
//
// Run: node eval/real-bug-holdout.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { diagnosePipeline } from '../engine/pipeline.ts';
import { errorOf, isAssertion, mentionsLocator, wilson } from '../engine/evidence/failure-signals.ts';
import { DATASET_ACCURACY } from '../engine/measured.ts';
import { readJsonl } from '../reporters/store.ts';
import { matchLabels, type GroundTruthLabel } from './evaluate.ts';
import type { Diagnosis } from '../reporters/types.ts';

const NL = String.fromCharCode(10);

/** In no tuned dataset: 471 labels nothing in the product has been fitted to. */
const HELD_OUT = { dataset: 'gutenberg-local', labels: 'eval/ground-truth.gutenberg-local.jsonl', data: 'data/real/gutenberg-local' };

export interface Case {
  dataset: string;
  held: boolean;
  testId: string;
  realBug: boolean;
  label: string;
  assertion: boolean;
  locator: boolean;
  /** Passes the history guard in `lastResortDiagnosis`: a clean failing streak, one error, two runs. */
  guard: boolean;
  /** The last-resort rule claimed this one, so it is absent from the pipeline's UNKNOWN set. */
  takenByRule: boolean;
}

const firedLastResort = (d: Diagnosis): boolean => (d.evidence ?? []).some((e) => e.source === 'last-resort-assertion');

/**
 * Every labelled failure the rules would refuse **if the last-resort rule did not exist**.
 *
 * That is `UNKNOWN` plus the cases the rule claimed. Filtering on UNKNOWN alone silently excludes
 * the population any widening of that rule would be selected on, which is how the same two signals
 * can be made to look like a fresh opportunity and like a reversal depending on which set is used.
 */
export async function preRuleResidue(root = process.cwd()): Promise<Case[]> {
  const sets = [...DATASET_ACCURACY.map((d) => ({ ...d, held: false })), { ...HELD_OUT, held: true }];
  const out: Case[] = [];
  for (const d of sets) {
    if (!existsSync(join(root, d.labels)) || !existsSync(join(root, d.data))) continue;
    const truth = readJsonl<GroundTruthLabel>(join(root, d.labels));
    const dataset = loadDataset(join(root, d.data));
    const matched = matchLabels(dataset.records, truth);
    if (matched.length === 0) continue;
    const index = new HistoryIndex(dataset.records, dataset.summaries);
    const rules = await diagnosePipeline(
      matched.map((m) => m.record),
      index,
      null,
    );
    for (const [i, m] of matched.entries()) {
      const taken = firedLastResort(rules[i]);
      if (rules[i].category !== 'UNKNOWN' && !taken) continue;
      const error = errorOf(m.record as never);
      const h = index.historyAsOf(m.record.testId, m.record.runId);
      out.push({
        dataset: d.dataset,
        held: d.held,
        testId: m.record.testId,
        realBug: m.label.label === 'REAL_BUG',
        label: m.label.label,
        assertion: isAssertion(error),
        locator: mentionsLocator(error),
        guard: h.runs >= 2 && h.failingStreak !== 0 && h.failuresBeforeStreak === 0 && h.streakDistinctErrors <= 1,
        takenByRule: taken,
      });
    }
  }
  return out;
}

const k = (pool: Case[]) => pool.filter((c) => c.realBug).length;
const show = (pool: Case[]) => (pool.length === 0 ? 'n/a' : `${k(pool)}/${pool.length} = ${Math.round((k(pool) / pool.length) * 100)}%`);
const points = (a: Case[], b: Case[]): string => (a.length === 0 || b.length === 0 ? 'n/a' : `${k(a) / a.length - k(b) / b.length > 0 ? '+' : ''}${(((k(a) / a.length - k(b) / b.length) * 1000) | 0) / 10} points`);

/** The rule as it is, and the one widening anybody would try first. */
export const CANDIDATES: Array<{ name: string; fires: (c: Case) => boolean }> = [
  { name: 'as shipped: an assertion that names no locator', fires: (c) => c.guard && c.assertion && !c.locator },
  { name: 'wider: names no locator, whatever the error', fires: (c) => c.guard && !c.locator },
];

function report(cases: Case[]): void {
  const lines: string[] = ['# would widening the last-resort rule buy anything?', ''];
  if (cases.length === 0) {
    lines.push('No labelled dataset is on this machine. The labelled failures are gitignored and stay local.', '');
    process.stdout.write(lines.join(NL));
    return;
  }

  const tuned = cases.filter((c) => !c.held);
  const held = cases.filter((c) => c.held);
  lines.push(
    `${cases.length} labelled failures the rules would refuse without the last-resort rule - ${show(cases)} of them real bugs. ` +
      `${tuned.length} from the tuned datasets (${show(tuned)}), ${held.length} from gutenberg-local, which is in none of them (${show(held)}). ` +
      `The rule itself claimed ${cases.filter((c) => c.takenByRule).length}, and measuring on the set without them is how this question gets answered backwards.`,
    '',
    'Base rates 49% and 21%, so only the movement a signal produces carries across - never the rate.',
    '',
    '## Each signal with the other held fixed',
    '',
    '| population | no locator, assertions only | no locator, non-assertions | assertion, no-locator only | assertion, with-locator only |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const [name, pool] of [
    ['all', cases],
    ['tuned', tuned],
    ['held out', held],
  ] as const) {
    const asserts = pool.filter((c) => c.assertion);
    const not = pool.filter((c) => !c.assertion);
    const noLoc = pool.filter((c) => !c.locator);
    const loc = pool.filter((c) => c.locator);
    lines.push(
      `| ${name} | ${points(asserts.filter((c) => !c.locator), asserts.filter((c) => c.locator))} | ${points(not.filter((c) => !c.locator), not.filter((c) => c.locator))} | ` +
        `${points(noLoc.filter((c) => c.assertion), noLoc.filter((c) => !c.assertion))} | ${points(loc.filter((c) => c.assertion), loc.filter((c) => !c.assertion))} |`,
    );
  }
  lines.push(
    '',
    'Both signals carry on the tuned data with the other held fixed. On the held-out corpus the assertion clause **inverts** where no ' +
      'locator is named - 4 of 19 against 6 of 6 - which is six cases and the single most likely place a future harvest changes this answer.',
    '',
    '## What widening would cost',
    '',
    '| rule | all corpora | tuned | held out | distinct tests |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const c of CANDIDATES) {
    const all = cases.filter(c.fires);
    const w = all.length > 0 ? wilson(k(all), all.length) : null;
    lines.push(
      `| ${c.name} | ${show(all)}${w ? ` [${Math.round(w.low * 100)}–${Math.round(w.high * 100)}%]` : ''} | ${show(tuned.filter(c.fires))} | ` +
        `${show(held.filter(c.fires))} | ${new Set(all.map((x) => x.testId)).size} |`,
    );
  }

  const shipped = cases.filter(CANDIDATES[0].fires);
  const wider = cases.filter(CANDIDATES[1].fires);
  const addedWrong = wider.filter((c) => !shipped.includes(c) && !c.realBug);
  lines.push(
    '',
    '## What this settles',
    '',
    `The rule as shipped re-derives at ${show(shipped)} over ${new Set(shipped.map((c) => c.testId)).size} distinct tests, which is the figure ` +
      '`LAST_RESORT_MEASURED` records. Widening it to every failure that names no locator would fire ' +
      `${wider.length - shipped.length} more times and be wrong ${addedWrong.length} of those, taking the rule from ${show(shipped)} to ${show(wider)}.`,
    '',
    `Refused. ${addedWrong.length} wrong causes is ${addedWrong.length} teams sent after a bug that is not there, which this project treats as ` +
      'the most expensive mistake it can make, and it is why the rule ships at 0.70 confidence rather than higher. The assertion clause is ' +
      'not tidying: it is the difference between the two rows above.',
    '',
    'What the wider rule gets right is not nothing - ' +
      `${k(wider) - k(shipped)} real bugs it would newly find, every one of the ${held.filter(CANDIDATES[1].fires).length} held-out fires among them. ` +
      'It is held here rather than shipped, because a rule chosen for the cases it gets right is the thing this harness exists to prevent.',
    '',
  );
  process.stdout.write(lines.join(NL));
}

if (import.meta.main) report(await preRuleResidue());
