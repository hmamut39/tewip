// Phase 161: the one command that writes to application code, and how far it can actually reach.
//
// `fix --code` filters for a REAL_BUG diagnosis at 0.85 or more before it will touch a line. Both
// numbers either side of that gate are fixed in code, and they do not meet: exactly one path emits
// REAL_BUG, at a hardcoded 0.40, and the model layer is capped at 0.45 so its verdicts always route
// to a person. Measured over 2,358 labelled failures, the gate opened 0 times.
//
// This file does not run that harness - it diagnoses thousands of failures and takes minutes. It
// guards the arithmetic that makes the result inevitable, so that if somebody raises the rule's
// confidence or lowers the gate, the claim in the README stops matching the code loudly rather than
// quietly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LLM_CONFIDENCE_CEILING } from '../llm/llm-diagnose.ts';
import { FIX_NEEDS } from '../../eval/autofix-reach.ts';
import { lf } from '../lines.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const ruleConfidence = () => {
  const src = readFileSync(join(ROOT, 'engine', 'rules.ts'), 'utf8');
  const m = /const REAL_BUG_ASSERTION_CONFIDENCE = ([\d.]+);/.exec(src);
  assert.ok(m, 'the rule that reports a real bug no longer declares its confidence as a constant');
  return Number(m[1]);
};

describe('how far fix --code can reach', () => {
  it('needs more confidence than any rule here produces', () => {
    assert.ok(
      ruleConfidence() < FIX_NEEDS,
      `the real-bug rule now claims ${ruleConfidence()} against a gate of ${FIX_NEEDS}. If that is deliberate, eval/autofix-reach.ts and the README both have to be re-run and rewritten: they say this command fires on nothing.`,
    );
  });

  it('needs more confidence than the model layer may ever claim', () => {
    assert.ok(
      LLM_CONFIDENCE_CEILING < FIX_NEEDS,
      'the model layer can now reach the code-changing gate, which no measurement here covers',
    );
  });

  it('is the only path that can report a real bug', () => {
    // If a second one appears, the measured reach of 0 in 2,358 stops being a fact about the code.
    const src = readFileSync(join(ROOT, 'engine', 'rules.ts'), 'utf8');
    const emits = [...src.matchAll(/category: 'REAL_BUG'/g)].length;
    assert.equal(emits, 1, `engine/rules.ts now emits REAL_BUG from ${emits} places; the reach measurement assumed one`);
  });

  it('says in the README that it fires on nothing, because it does', () => {
    const readme = lf(readFileSync(join(ROOT, 'README.md'), 'utf8'));
    assert.match(readme, /0 \(0\.00%\)/, 'the measured reach is not stated where the capability is advertised');
    assert.match(readme, /node eval\/autofix-reach\.ts/, 'the README does not name the harness that re-derives it');
  });
});
