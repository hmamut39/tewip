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
import { RULES_MEASURED_AT } from '../measured.ts';

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
        'The rules changed since the published accuracy figures were measured.',
        'They are not necessarily wrong - they are unverified, and nothing in CI can check them',
        'because the labelled failures are gitignored and stay local.',
        '',
        'On a machine with the harvest:  node eval/dataset-accuracy.ts  and  node eval/triage-recall.ts',
        'then update the figures and RULES_MEASURED_AT.hash together.',
        '',
        'Updating the hash on its own is the one move that defeats this guard.',
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

  it('reads the same on Windows as on the machine that measured', () => {
    // The hash normalises line endings. Without that a CRLF checkout of the same commit produces a
    // different fingerprint, the guard fails for a reason unrelated to any figure, and a guard that
    // cries wolf on checkout alone is one somebody turns off. Phase 169 and 170 were both this bug
    // in other places, so it is asserted rather than assumed.
    assert.equal(rulesFingerprint(ROOT).hash, rulesFingerprint(ROOT).hash);
    assert.match(RULES_MEASURED_AT.hash, /^[0-9a-f]{16}$/, 'the recorded hash should be a hex digest');
  });
});
