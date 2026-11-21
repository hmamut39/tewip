// Phase 196: the agent registry, and the two ways it would have been useless.
//
// "Every agent and its owner. No shadow agents." is in five of the seven national governance
// frameworks and in both guardrail catalogues. The control is not the list - `tewip agent` already
// printed one - it is the comparison: that what is here is what somebody approved, and that they
// are told when it is not.
//
// Both near-misses are tested here because both were found by using it rather than by reading it:
// a baseline written where git ignores it is never committed and the diff never fires, and a gated
// run that writes the baseline accepts the thing it has just flagged.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedSince, hashOf, inventoryOf, renderInventory, type Capability, type Inventory } from '../agent/inventory.ts';
import { INVENTORY_AT } from '../agent/agent-command.ts';

const ROOT = join(import.meta.dirname, '..', '..');

const scanWith = (tools: Array<{ name: string; reach: string; file: string }>, guards: string[] = []) =>
  ({
    tools: tools.map((t) => ({ ...t, line: 1, shape: 'tool(', description: '', why: '', capabilities: [] })),
    guards: guards.map((kind) => ({ kind, file: 'a.ts', line: 1, evidence: '' })),
    doors: [],
    injections: [],
    poisoned: [],
    filesRead: 1,
    coverage: [],
    evals: { frameworks: [], files: [] },
    config: { read: [], findings: [], servers: [], hasAllowList: false, hasEnforcedHook: false },
    emptyBudget: null,
  }) as never;

describe('the capability baseline', () => {
  it('is written where git will keep it, not where Tewip ignores its own output', () => {
    // The flaw caught before shipping. `.tewip/` is gitignored by this project's own convention, so
    // a baseline written there is never committed, never reaches CI, and the diff never fires -
    // and the check would report "nothing to compare against yet" forever while looking healthy.
    assert.ok(!INVENTORY_AT.startsWith('.tewip'), 'the baseline must not live in the ignored directory');
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    assert.ok(ignore.includes('.tewip/'), 'this test only means something while .tewip/ is ignored');
    for (const line of ignore.split(String.fromCharCode(10))) {
      assert.notEqual(line.trim(), INVENTORY_AT, `${INVENTORY_AT} is in .gitignore, so no baseline would ever be committed`);
    }
  });

  it('does not change when a file moves', () => {
    const a = inventoryOf(scanWith([{ name: 'refund', reach: 'pays', file: 'src/tools.ts' }]));
    const b = inventoryOf(scanWith([{ name: 'refund', reach: 'pays', file: 'lib/agent/tools.ts' }]));
    assert.equal(a.hash, b.hash, 'a tool that moved is the same tool; a hash that moved with it would be re-baselined unread');
  });

  it('changes when a capability changes reach', () => {
    const a = inventoryOf(scanWith([{ name: 'send', reach: 'reads', file: 'a.ts' }]));
    const b = inventoryOf(scanWith([{ name: 'send', reach: 'sends', file: 'a.ts' }]));
    assert.notEqual(a.hash, b.hash, 'the same name doing something further-reaching is a different capability');
  });

  it('does not depend on the order files were walked in', () => {
    // Walk order differs between platforms, and a project that hashed two ways would be
    // re-baselined on every machine until somebody stopped reading the diff.
    const one = inventoryOf(scanWith([{ name: 'b', reach: 'reads', file: 'b.ts' }, { name: 'a', reach: 'reads', file: 'a.ts' }]));
    const two = inventoryOf(scanWith([{ name: 'a', reach: 'reads', file: 'a.ts' }, { name: 'b', reach: 'reads', file: 'b.ts' }]));
    assert.equal(one.hash, two.hash);
  });

  it('names what arrived and what went', () => {
    const before = inventoryOf(scanWith([{ name: 'read_file', reach: 'reads', file: 'a.ts' }]));
    const after = inventoryOf(scanWith([{ name: 'delete_user', reach: 'deletes', file: 'a.ts' }]));
    const { added, removed } = changedSince(before, after);
    assert.deepEqual(added.map((c) => c.name), ['delete_user']);
    assert.deepEqual(removed.map((c) => c.name), ['read_file']);
  });

  it('says plainly when something that arrived cannot be undone', () => {
    const before = inventoryOf(scanWith([]));
    const after = inventoryOf(scanWith([{ name: 'wipe', reach: 'deletes', file: 'a.ts' }]));
    const page = renderInventory(after, before).join(String.fromCharCode(10));
    assert.match(page, /new tool.*wipe/);
    assert.match(page, /cannot be undone/);
  });

  it('prints a fingerprint that describes the list beside it', () => {
    // A stored baseline carries its own hash and somebody can edit the file. When the two
    // disagreed the report printed `x to x` beside a list of changes, which reads as a broken diff
    // rather than as a touched baseline.
    const real = inventoryOf(scanWith([{ name: 'a', reach: 'reads', file: 'a.ts' }, { name: 'b', reach: 'reads', file: 'b.ts' }]));
    const tampered: Inventory = { ...real, capabilities: real.capabilities.slice(0, 1) };
    const now = inventoryOf(scanWith([{ name: 'a', reach: 'reads', file: 'a.ts' }, { name: 'b', reach: 'reads', file: 'b.ts' }]));
    const page = renderInventory(now, tampered).join(String.fromCharCode(10));
    assert.ok(!page.includes(`\`${now.hash}\` to \`${now.hash}\``), 'a changed list must not print the same fingerprint twice');
    assert.match(page, new RegExp(hashOf(tampered.capabilities)), 'the baseline fingerprint is derived from the list it describes');
  });

  it('counts one entry per guard kind, not one per place it is written', () => {
    const many = inventoryOf(scanWith([], ['step-budget', 'step-budget', 'step-budget']));
    assert.equal(many.capabilities.filter((c: Capability) => c.kind === 'guard').length, 1, 'six ceilings in six files are one control');
  });

  it('does not write the baseline on a gated run', () => {
    // The second near-miss, and the one that would have made the gate pointless. The first gated
    // run failed on an unapproved capability, wrote the new baseline on its way out, and the next
    // run passed: a gate that can only ever fail once. Writing is approval and gating is checking,
    // and a check that accepts what it has just flagged is not one.
    const runner = readFileSync(join(ROOT, 'engine', 'agent', 'run-agent.ts'), 'utf8');
    const wrote = runner.indexOf('writeFileSync(at');
    assert.ok(wrote > 0, 'the runner must write a baseline somewhere');
    assert.match(runner.slice(Math.max(0, wrote - 400), wrote), /if \(!cmd\.gate\)/, 'the write must sit behind a check that this is not a gated run');
  });
});
