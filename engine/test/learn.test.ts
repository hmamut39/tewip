// What `tewip learn` must never do: invent a pattern out of one disagreement, blame a rule it
// cannot name, or let one flaky test corrected six times look like six pieces of evidence. Those
// three are the whole point of the report, so they are what is tested here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asLabels, ENOUGH_FOR_A_PATTERN, renderLearning, whatWeLearned } from '../learn/learn.ts';
import { errorShape } from '../signature.ts';
import type { Correction } from '../corrections.ts';
import type { VerdictCorrection } from '../learn/verdicts.ts';
import type { TriageRecord } from '../../reporters/types.ts';

const NL = String.fromCharCode(10);

const record = (testId: string, error: string, said: string, ruleId?: string, source = 'rules'): TriageRecord =>
  ({
    schemaVersion: 1, testId, file: 'tests/a.spec.ts', status: 'failed', errorMessage: error, errorStack: '',
    duration: 1, retry: 0, attachments: [], runId: 'r1', gitSha: '', timestamp: '2026-09-01T00:00:00.000Z',
    diagnosis: { category: said, confidence: 0.8, source, ruleId, evidence: [] },
  }) as unknown as TriageRecord;

const correction = (testId: string, error: string, was: string, now: string): Correction =>
  ({
    schemaVersion: 1, testId, errorShape: errorShape(error), category: now, by: 'sam',
    at: '2026-09-02T00:00:00.000Z', reason: '', source: 'test', wasCategory: was,
  }) as unknown as Correction;

/** Three failures of the same shape, all wrongly called REAL_BUG by the same rule. */
function aPattern(tests = ['a', 'b', 'c']): { corrections: Correction[]; records: TriageRecord[] } {
  const error = (n: string) => `TimeoutError: locator.click: Timeout 10000ms exceeded waiting for ${n}`;
  return {
    corrections: tests.map((t) => correction(t, error(t), 'REAL_BUG', 'TIMING')),
    records: tests.map((t) => record(t, error(t), 'REAL_BUG', 'real-bug-assertion')),
  };
}

describe('what the corrections add up to', () => {
  it('refuses to call two corrections a pattern, and says what would make one', () => {
    const { corrections, records } = aPattern(['a', 'b']);
    const learned = whatWeLearned(corrections, [], records);
    assert.equal(learned.mistakes.length, 0, 'two is not a pattern');
    assert.equal(learned.notYet.length, 1);
    assert.match(learned.notYet[0], new RegExp(`${ENOUGH_FOR_A_PATTERN} of the same shape would be`));
    assert.match(renderLearning(learned), /No pattern yet/);
  });

  it('calls three a pattern, and names the rule that decided them', () => {
    const { corrections, records } = aPattern();
    const [mistake] = whatWeLearned(corrections, [], records).mistakes;
    assert.equal(mistake.count, ENOUGH_FOR_A_PATTERN);
    assert.equal(mistake.said, 'REAL_BUG');
    assert.equal(mistake.corrected, 'TIMING');
    assert.equal(mistake.rule, 'real-bug-assertion', 'the rule to go and read');
    assert.deepEqual(mistake.rules, [{ rule: 'real-bug-assertion', count: 3 }]);
    assert.equal(mistake.from, 'rules 3');
  });

  it('does not blame one rule when no rule is behind most of them', () => {
    const error = (n: string) => `expect(locator).toBeVisible() failed for ${n}`;
    const tests = ['a', 'b', 'c', 'd'];
    const rules = ['locator-drift', 'real-bug-assertion', 'timing-flaky', 'env-network'];
    const learned = whatWeLearned(
      tests.map((t) => correction(t, error(t), 'REAL_BUG', 'TIMING')),
      [],
      tests.map((t, i) => record(t, error(t), 'REAL_BUG', rules[i])),
    );
    const [mistake] = learned.mistakes;
    assert.equal(mistake.rule, '', 'four rules once each is not one rule to blame');
    assert.equal(mistake.rules.length, 4);
    assert.match(renderLearning(learned), /no single rule is behind these/);
  });

  it('says when every correction is the same test, so it does not read as many', () => {
    const error = 'TimeoutError: locator.dragTo: Timeout 10000ms exceeded';
    const learned = whatWeLearned(
      [1, 2, 3].map(() => correction('one flaky test', error, 'TIMING', 'ENV')),
      [],
      [record('one flaky test', error, 'TIMING', 'timing-retry-pass')],
    );
    const [mistake] = learned.mistakes;
    assert.equal(mistake.count, 3);
    assert.equal(mistake.tests, 1);
    assert.match(renderLearning(learned), /a single test.*rather than with a rule/);
    assert.equal(mistake.examples.length, 1, 'one test is one example, not three copies of it');
  });

  it('prefers different tests as examples over repeats of one', () => {
    const error = (n: string) => `TimeoutError: waiting for ${n}`;
    const corrections = [
      correction('repeated', error('x'), 'REAL_BUG', 'TIMING'),
      correction('repeated', error('x'), 'REAL_BUG', 'TIMING'),
      correction('repeated', error('x'), 'REAL_BUG', 'TIMING'),
      correction('other', error('y'), 'REAL_BUG', 'TIMING'),
    ];
    const records = [record('repeated', error('x'), 'REAL_BUG'), record('other', error('y'), 'REAL_BUG')];
    const [mistake] = whatWeLearned(corrections, [], records).mistakes;
    assert.deepEqual([...new Set(mistake.examples.map((e) => e.testId))].sort(), ['other', 'repeated']);
  });

  it('reads the real failures, not just the corrections, to say what they share', () => {
    const { corrections, records } = aPattern();
    const [mistake] = whatWeLearned(corrections, [], records).mistakes;
    assert.ok(mistake.common.includes('locator'), `shared words came from the errors: ${mistake.common.join()}`);
    assert.ok(!mistake.common.includes('timeout'), 'words every failure has are not a finding');
    assert.match(mistake.examples[0].error, /locator\.click/);
  });

  it('gives the corrections a denominator, so 3 of 500 does not read like 3 of 3', () => {
    const { corrections, records } = aPattern();
    const report = renderLearning(whatWeLearned(corrections, [], records, 500));
    assert.match(report, /3 diagnosis correction\(s\) of 500 diagnoses kept here, which is 0\.6%/);
  });

  it('says plainly when nobody has corrected anything', () => {
    const report = renderLearning(whatWeLearned([], [], []));
    assert.match(report, /Nothing yet: nobody has corrected anything here/);
    assert.match(report, /tewip correct diagnosis/);
  });

  it('counts corrections of the other verdicts too, without mixing them into the diagnoses', () => {
    const verdicts = [
      { schemaVersion: 1, kind: 'flaky', key: 'a', verdict: 'fix-now', by: 'sam', at: '2026-09-02T00:00:00.000Z', reason: '' },
      { schemaVersion: 1, kind: 'flaky', key: 'b', verdict: 'watch', by: 'alex', at: '2026-09-03T00:00:00.000Z', reason: '' },
    ] as VerdictCorrection[];
    const learned = whatWeLearned([], verdicts, []);
    assert.equal(learned.diagnoses, 0);
    assert.deepEqual(learned.others, [{ kind: 'flaky', count: 2 }]);
    assert.deepEqual(learned.people.sort(), ['alex', 'sam']);
  });

  it('exports the corrections as labelled examples a rule change can be measured against', () => {
    const { corrections } = aPattern();
    const lines = asLabels(corrections).split(NL).map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].category, 'TIMING');
    assert.equal(lines[0].was, 'REAL_BUG', 'both answers, so the pair is usable as training data');
    assert.equal(lines[0].source, 'tewip correct');
  });
});
