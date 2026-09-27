// Phase 23, the half that decides whether the answers can be trusted: what may be changed.
//
// A mutation tool is only as good as its restraint. Change a word in a string and you report a hole
// that is not one. Change a loop's comparison and you do not get a failing test, you get a machine
// that hangs - the same shape of mistake as the fork bomb in Phase 21, and the reason loop headers are
// untouchable here. These tests hold that restraint in place.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyMutant, mutantsFor } from '../prove/mutants.ts';

const NL = String.fromCharCode(10);
const file = (...lines: string[]) => lines.join(NL);

describe('what may be broken on purpose', () => {
  it('moves a boundary, inverts a condition, flips a flag', () => {
    const source = file('function fee(total) {', '  if (total >= 100) return 0.1;', '  return 0;', '}');
    const kinds = mutantsFor(source).map((m) => m.kind);
    assert.ok(kinds.includes('a boundary moved by one'), `expected a boundary change, got ${kinds.join(', ')}`);
    const boundary = mutantsFor(source).find((m) => m.kind === 'a boundary moved by one');
    assert.match(boundary?.now ?? '', /total > 100/);
  });

  it('never changes anything inside a string or a comment', () => {
    // A message is not behaviour. Reporting "your tests did not notice this text change" would train
    // people to ignore the whole report.
    const source = file(
      'function greet(name) {',
      "  // if (name >= 'a') this comment is not code",
      "  const hint = 'use >= for inclusive ranges, and && for both';",
      '  return hint + name;',
      '}',
    );
    for (const mutant of mutantsFor(source)) {
      assert.ok(!mutant.was.startsWith('//'), `changed a comment: ${mutant.was}`);
      assert.ok(!mutant.was.includes('use >= for inclusive'), `changed a string: ${mutant.was}`);
    }
  });

  it('never touches a line that could loop', () => {
    // A flipped comparison in a loop header does not fail a test, it runs forever.
    const source = file(
      'function sum(items) {',
      '  let total = 0;',
      '  for (let i = 0; i < items.length; i += 1) total += items[i];',
      '  while (total > 100) total -= 1;',
      '  return total;',
      '}',
    );
    for (const mutant of mutantsFor(source)) {
      assert.ok(!/\b(for|while)\b/.test(mutant.was), `touched a loop: ${mutant.was}`);
    }
  });

  it('leaves logging and imports alone, because changing them proves nothing', () => {
    const source = file("import { x } from './x.js';", '', 'function go(a, b) {', '  console.log(a + b);', '  return a + b;', '}');
    const changed = mutantsFor(source);
    assert.ok(changed.length > 0);
    for (const mutant of changed) {
      assert.ok(!mutant.was.includes('console.log'), 'a log line is not behaviour');
      assert.ok(!mutant.was.startsWith('import'), 'an import is not behaviour');
    }
  });

  it('makes one change per line, so each answer is about one thing', () => {
    const source = file('function ok(a, b, c) {', '  return a >= 1 && b <= 2 && c === 3;', '}');
    const online = mutantsFor(source).filter((m) => m.line === 2);
    assert.equal(online.length, 1);
  });

  it('spreads its changes over the file rather than taking the first few', () => {
    // Six changes to one function say much less about a suite than six changes in six places.
    const lines = ['function big() {'];
    for (let i = 0; i < 40; i += 1) lines.push(`  if (v${i} >= ${i}) return ${i};`);
    lines.push('}');
    const picked = mutantsFor(file(...lines), 4).map((m) => m.line);
    assert.equal(picked.length, 4);
    assert.ok(picked[3] - picked[0] > 20, `changes are bunched together: ${picked.join(', ')}`);
  });

  it('refuses to write a change to a line that is not what it was made from', () => {
    // The guard that stops a stale mutant from editing the wrong line of a file somebody just saved.
    const source = file('function fee(total) {', '  if (total >= 100) return 0.1;', '}');
    const mutant = mutantsFor(source)[0];
    const moved = file('function fee(total) {', '  // somebody edited this file', '}');
    assert.throws(() => applyMutant(moved, mutant), /not what the mutant was made from/);
  });

  it('applies exactly one line and leaves the rest alone', () => {
    const source = file('function fee(total) {', '  if (total >= 100) return 0.1;', '  return 0;', '}');
    const mutant = mutantsFor(source).find((m) => m.line === 2)!;
    const after = applyMutant(source, mutant).split(NL);
    assert.equal(after.length, 4);
    assert.match(after[1], /total > 100/);
    assert.equal(after[2], '  return 0;');
  });
});
