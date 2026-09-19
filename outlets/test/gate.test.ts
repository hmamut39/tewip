// Unit tests for the smart merge gate: which failures may be let through and which must block.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gate, gateSummary, isNoise, writeGateOutputs } from '../../ci/gate.ts';
import type { Diagnosis } from '../../reporters/types.ts';
import type { TriageItem } from '../items.ts';

const item = (title: string, d: Partial<Diagnosis>): TriageItem =>
  ({ title, testId: title, diagnosis: { category: 'TIMING', confidence: 0.8, source: 'rules', engineVersion: 'x', diagnosedAt: '', evidence: [], ...d } }) as TriageItem;

describe('smart merge gate', () => {
  it("lets through a rule's or a person's flaky and environment verdicts", () => {
    assert.equal(isNoise(item('a', { category: 'TIMING', source: 'rules', confidence: 0.75 })), true);
    assert.equal(isNoise(item('b', { category: 'ENV', source: 'rules', confidence: 0.9 })), true);
    assert.equal(isNoise(item('c', { category: 'TIMING', source: 'human', confidence: 1 })), true);
  });

  it('blocks real bugs, changed selectors, test data and undecided failures', () => {
    for (const category of ['REAL_BUG', 'LOCATOR_DRIFT', 'TEST_DATA', 'UNKNOWN'] as const) {
      assert.equal(isNoise(item(category, { category, source: 'rules', confidence: 0.9 })), false, category);
    }
  });

  it('blocks an AI-only or low-confidence flaky verdict: the less reliable half never waves a failure through', () => {
    assert.equal(isNoise(item('ai', { category: 'TIMING', source: 'llm', confidence: 0.95 })), false);
    assert.equal(isNoise(item('weak', { category: 'ENV', source: 'rules', confidence: 0.6 })), false);
  });

  it('passes when every failure is noise, fails when one needs someone, and says which', () => {
    const noise = [item('flaky one', { category: 'TIMING' }), item('outage', { category: 'ENV', confidence: 0.9 })];
    assert.equal(gate(noise).blocking.length, 0);
    assert.match(gateSummary(gate(noise)), /passing - all 2 failure\(s\) are flaky \(1\) or environment \(1\)/);

    const mixed = [...noise, item('checkout total', { category: 'REAL_BUG', confidence: 0.8 })];
    const result = gate(mixed);
    assert.equal(result.blocking.length, 1);
    assert.match(gateSummary(result), /failing - 1 failure\(s\) need someone: checkout total \(REAL_BUG\)\. 2 other failure\(s\) are flaky or environment/);
  });

  it('writes the counts as step outputs', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'triage-gate-')), 'out');
    writeGateOutputs(file, gate([item('x', { category: 'TIMING' }), item('y', { category: 'REAL_BUG' })]));
    assert.equal(readFileSync(file, 'utf8'), 'blocking=1\nflaky=1\nenvironment=0\n');
  });
});
