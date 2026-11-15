// The guard that notices a published figure has gone stale.
//
// Track A of the plan, and the narrowest useful version of it. The labelled failures are
// deliberately local - `.gitignore`: "collected triage data stays local" - so CI cannot re-derive
// an accuracy figure, and for seven weeks nothing noticed that the headline was ten points high.
// Committing the corpus is not on the table, so this does the half that needs no data: the figures
// record the rules code they were measured against, and this goes red when that code has moved.
//
// It cannot say what the new figure is. It can refuse to let an unverified one pass as verified.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES_ENTRY, fingerprint, importClosure, rulesFingerprint } from '../fingerprint.ts';
import { MODEL_LAYER, MODEL_PRECISION, RULES_MEASURED_AT } from '../measured.ts';

const ROOT = join(import.meta.dirname, '..', '..');

describe('the figures know which rules they were measured against', () => {
  it('still sees every file the rules reach', () => {
    const files = importClosure(RULES_ENTRY, ROOT);
    assert.equal(
      files.length,
      RULES_MEASURED_AT.files,
      `the rules now reach ${files.length} source files, not ${RULES_MEASURED_AT.files}. If that is a real change, re-measure and update RULES_MEASURED_AT.`,
    );
    // A closure that silently collapses to one file would make the hash below agree with itself
    // forever. Phase 176 shipped exactly that bug in a different check, so it is asserted here.
    assert.ok(files.includes('engine/rules.ts'), 'the closure must reach the rule engine itself');
    assert.ok(files.includes(RULES_ENTRY), 'the closure must include its own entry point');
    for (const rel of files) assert.ok(existsSync(join(ROOT, rel)), `${rel} is in the closure but not on disk`);
  });

  it('goes red when the rules have moved since the figures were measured', () => {
    const { hash } = rulesFingerprint(ROOT);
    assert.equal(
      hash,
      RULES_MEASURED_AT.hash,
      [
        'The rules changed since the published figures were measured.',
        'They are not necessarily wrong - they are unverified, and nothing in CI can check them',
        'because the labelled failures are gitignored and stay local.',
        '',
        'On a machine with the harvest, run EVERY one of these, not the ones you remember:',
        ...RULES_MEASURED_AT.harnesses.map((h) => `  ${h}`),
        '',
        'then update the figures and RULES_MEASURED_AT.hash together.',
        '',
        'Updating the hash on its own is the one move that defeats this guard. Running some of the',
        'harnesses is the move that half-defeats it, which is what happened in Phase 179: the model',
        'layer figures depend on the rules too, because the model is only ever asked what the rules',
        'refuse, and they were left stale while the other two were corrected.',
      ].join('\n'),
    );
  });

  it('hashes the contents, not just the names', () => {
    // Otherwise a rule could change completely while the fingerprint stood still, and the guard
    // above would agree with itself forever. Checked on a scratch tree rather than asserted.
    const dir = mkdtempSync(join(tmpdir(), 'tewip-fp-'));
    try {
      writeFileSync(join(dir, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
      writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
      const before = fingerprint(importClosure('a.ts', dir), dir);
      writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
      const after = fingerprint(importClosure('a.ts', dir), dir);
      assert.notEqual(before, after, 'changing an imported file must move the fingerprint');

      // And the walk has to follow imports, not just hash the entry point.
      assert.deepEqual(importClosure('a.ts', dir), ['a.ts', 'b.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a line-ending change, which is not a change to a rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tewip-fp-'));
    try {
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\nexport const c = 2;\n');
      const unix = fingerprint(['a.ts'], dir);
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\r\nexport const c = 2;\r\n');
      assert.equal(fingerprint(['a.ts'], dir), unix, 'a CRLF checkout must fingerprint the same');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names a harness for every figure that moves when the rules move', () => {
    // The Phase 180 guard. Each of these exports is derived from the rules, so each has to be
    // re-derived when the fingerprint moves - and the only thing that makes that happen is this
    // list being complete. A figure with no harness named here is a figure that will go stale
    // exactly the way MODEL_LAYER did, with CI green the whole time.
    const named = RULES_MEASURED_AT.harnesses.join(' ');
    for (const [figure, harness] of [
      ['DATASET_ACCURACY', 'eval/dataset-accuracy.ts'],
      ['TRIAGE_RECALL', 'eval/triage-recall.ts'],
      ['MODEL_LAYER and MODEL_PRECISION', 'eval/model-layer.ts'],
    ] as const) {
      assert.ok(named.includes(harness), `${figure} is derived from the rules but ${harness} is not in RULES_MEASURED_AT.harnesses`);
      assert.ok(existsSync(join(ROOT, harness)), `${harness} is named but does not exist`);
    }
    assert.equal(RULES_MEASURED_AT.harnesses.length, 3, 'a harness added or removed here needs this count moved deliberately');
  });

  it('keeps the model-layer record arithmetically whole', () => {
    // MODEL_LAYER went stale in Phase 179 and nothing noticed. These are the internal checks that
    // at least catch a figure updated by hand in part.
    assert.equal(MODEL_LAYER.asked, MODEL_LAYER.answered + MODEL_LAYER.refused);
    assert.equal(
      MODEL_PRECISION.reduce((a, r) => a + r.said, 0),
      MODEL_LAYER.answered,
      'the per-cause rows must add up to what the layer answered',
    );
    assert.equal(
      MODEL_PRECISION.reduce((a, r) => a + r.right, 0),
      MODEL_LAYER.right,
      'and to what it got right',
    );
  });

  it('reads the same on Windows as on the machine that measured', () => {
    // The hash normalises line endings. Without that a CRLF checkout of the same commit produces a
    // different fingerprint, the guard fails for a reason unrelated to any figure, and a guard that
    // cries wolf on checkout alone is one somebody turns off. Phase 169 and 170 were both this bug
    // in other places, so it is asserted rather than assumed.
    assert.equal(rulesFingerprint(ROOT).hash, rulesFingerprint(ROOT).hash);
    assert.match(RULES_MEASURED_AT.hash, /^[0-9a-f]{16}$/, 'the recorded hash should be a hex digest');
  });
});
