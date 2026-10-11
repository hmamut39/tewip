// Phase 29: reading a browser run.
//
// The shapes below were taken from real axe-core 4.14 output, produced by running axe over nine
// real pages (bootstrap's own component pages and excalidraw's index) rather than written from the
// documentation. That matters for two of them in particular: the `best-practice` tag with no wcag
// tag beside it, which is how axe marks a rule that tests no standard, and the `EN-9.1.4.3` tag,
// which is the clause of EN 301 549 the European Accessibility Act actually cites.
//
// What is being tested is again mostly restraint: not over-claiming coverage, not discarding a
// source finding about a page the browser never opened, and not calling somebody's good idea a
// barrier.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EQUIVALENT_AXE_RULE, readAxeReport } from '../access/reports.ts';
import { merge, nowChecked, pagesAsFiles, stillNotChecked } from '../access/merge.ts';
import { NOT_CHECKED, RULES } from '../access/wcag.ts';
import type { Finding } from '../access/checks.ts';

/** A rule as axe writes it. */
function rule(id: string, tags: string[], impact: string, nodes = 1) {
  return {
    id,
    impact,
    tags,
    description: `${id} description`,
    help: `${id} help`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`,
    nodes: Array.from({ length: nodes }, (_, i) => ({
      html: `<div id="n${i}">`,
      target: [`#n${i}`],
      failureSummary: `Fix any of the following:\n  ${id} failed on node ${i}`,
    })),
  };
}

function report(run: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tewip-axe-')), 'axe.json');
  writeFileSync(path, JSON.stringify(run), 'utf8');
  return path;
}

// The real tags, copied from the generated run.
const CONTRAST = ['cat.color', 'wcag2aa', 'wcag143', 'TTv5', 'TT13.c', 'EN-301-549', 'EN-9.1.4.3', 'ACT'];
const LABEL = ['cat.forms', 'wcag2a', 'wcag412', 'EN-301-549', 'EN-9.4.1.2'];
const REGION = ['cat.keyboard', 'best-practice'];

describe('reading an axe run', () => {
  it('reads the criterion, the level and the EN 301 549 clause from the tags', () => {
    const run = readAxeReport(report({ url: 'http://x/', violations: [rule('color-contrast', CONTRAST, 'serious')], incomplete: [], passes: [] }));
    const f = run.findings[0];
    assert.equal(f.criterion, '1.4.3');
    assert.equal(f.level, 'AA');
    assert.equal(f.en301549, '9.1.4.3');
    assert.equal(f.confidence, 'barrier');
    assert.equal(f.severity, 'blocker');
  });

  it('a two-digit criterion is 1.4.11, there being no fourteenth principle', () => {
    const run = readAxeReport(report({ violations: [rule('target-size', ['wcag22aa', 'wcag258'], 'serious')], incomplete: [] }));
    assert.equal(run.findings[0].criterion, '2.5.8');
    const deep = readAxeReport(report({ violations: [rule('x', ['wcag21aa', 'wcag1411'], 'minor')], incomplete: [] }));
    assert.equal(deep.findings[0].criterion, '1.4.11');
  });

  it("a rule tagged best-practice with no criterion is advice, whatever axe's impact says", () => {
    const run = readAxeReport(report({ violations: [rule('region', REGION, 'moderate', 40)], incomplete: [] }));
    assert.equal(run.findings.length, 40);
    assert.ok(run.findings.every((f) => f.confidence === 'advice'));
    assert.ok(run.findings.every((f) => f.criterion === null));
    // Never a blocker, so it can never fail a build.
    assert.ok(run.findings.every((f) => f.severity === 'minor'));
  });

  it('what axe could not determine becomes a question, not a barrier', () => {
    const run = readAxeReport(report({ violations: [], incomplete: [rule('color-contrast', CONTRAST, 'serious', 70)] }));
    assert.equal(run.findings.length, 70);
    assert.ok(run.findings.every((f) => f.confidence === 'ask-a-person'));
    assert.match(run.findings[0].why, /axe could not determine this one/);
  });

  it('a rule that passed is coverage, not a finding', () => {
    const run = readAxeReport(report({ violations: [], incomplete: [], passes: [rule('color-contrast', CONTRAST, 'serious')] }));
    assert.equal(run.findings.length, 0, 'a passing rule must not be reported');
    assert.ok(run.rulesRun.has('color-contrast'), 'but it has still been checked');
    assert.ok(run.criteriaCovered.has('1.4.3'));
  });

  it('reads a list of runs, and a list of { page, result } wrappers', () => {
    const one = { url: 'http://a/', violations: [rule('label', LABEL, 'critical')], incomplete: [] };
    const two = { url: 'http://b/', violations: [rule('label', LABEL, 'critical')], incomplete: [] };
    assert.equal(readAxeReport(report([one, two] as never)).findings.length, 2);
    const wrapped = readAxeReport(report([{ page: 'ignored', result: one }] as never));
    assert.equal(wrapped.findings.length, 1);
    // axe's own url wins over the wrapper's label, because it is what axe actually loaded.
    assert.equal(wrapped.findings[0].page, 'http://a/');
  });

  it('refuses a file that is not an axe report rather than calling the page clean', () => {
    assert.throws(() => readAxeReport(report({ lighthouseVersion: '12', audits: {} })), /not an axe report/);
    const notJson = join(mkdtempSync(join(tmpdir(), 'tewip-axe-')), 'x.json');
    writeFileSync(notJson, 'not json at all', 'utf8');
    assert.throws(() => readAxeReport(notJson), /not JSON/);
  });

  it('every rule Tewip reads from source names the axe rule that would re-check it, or none', () => {
    for (const name of Object.keys(RULES)) {
      const equivalent = EQUIVALENT_AXE_RULE[name];
      assert.ok(equivalent === undefined || typeof equivalent === 'string', name);
    }
    // click-without-keyboard has no axe equivalent and must never acquire one by accident.
    assert.equal(EQUIVALENT_AXE_RULE['click-without-keyboard'], undefined);
  });
});

const sourceFinding = (rule: string, file: string): Finding => ({
  rule,
  confidence: 'barrier',
  file,
  line: 1,
  element: '<input>',
  why: 'why',
  next: 'next',
});

describe('joining the source read to the browser run', () => {
  const runOver = (page: string) =>
    readAxeReport(report([{ url: page, violations: [], incomplete: [], passes: [rule('label', LABEL, 'critical')] }] as never));

  it('sets aside a source finding the run re-checked on that same page', () => {
    const run = runOver('file:///repo/signup.html');
    const { kept, superseded } = merge([sourceFinding('input-label', 'signup.html')], run, '/repo');
    assert.equal(superseded.length, 1);
    assert.equal(kept.length, 0);
  });

  it('keeps a source finding about a page the run never opened', () => {
    const run = runOver('file:///repo/signup.html');
    const { kept, superseded } = merge([sourceFinding('input-label', 'admin/users.html')], run, '/repo');
    assert.equal(kept.length, 1, 'the browser said nothing about this file');
    assert.equal(superseded.length, 0);
  });

  it('keeps a source finding whose rule axe has no equivalent for', () => {
    const run = runOver('file:///repo/signup.html');
    const { kept } = merge([sourceFinding('click-without-keyboard', 'signup.html')], run, '/repo');
    assert.equal(kept.length, 1);
  });

  it('resolves the pages a run opened to repository-relative files', () => {
    const run = runOver('file:///C:/repo/a/b.html');
    assert.deepEqual([...pagesAsFiles(run, 'C:\\repo')], ['a/b.html']);
  });
});

describe('what the run is allowed to claim', () => {
  it('a contrast rule that ran moves contrast out of the unchecked list', () => {
    const ran = new Set(['color-contrast']);
    assert.ok(nowChecked(ran).some((n) => n.criterion.startsWith('1.4.3')));
    assert.ok(!stillNotChecked(ran).some((n) => n.criterion.startsWith('1.4.3')));
  });

  it('nothing else on that list can be settled by a tool, however many rules ran', () => {
    // image-alt checks that an alt attribute exists. It has no opinion on whether the words are
    // any good, which is what the 1.1.1 entry is about. Matching on criterion number alone made
    // Tewip claim it had checked alt-text quality and timing behaviour.
    const everything = new Set(['color-contrast', 'image-alt', 'label', 'button-name', 'frame-title', 'tabindex']);
    const remaining = stillNotChecked(everything).map((n) => n.criterion);
    assert.ok(remaining.some((c) => c.startsWith('1.1.1')), 'alt-text quality is never settled by a tool');
    assert.ok(remaining.some((c) => c.startsWith('2.2.1')), 'timing is never settled by a tool');
    assert.ok(remaining.some((c) => c.startsWith('2.4.7')));
    assert.equal(remaining.length, NOT_CHECKED.length - 1, 'only contrast is settleable');
  });

  it('a run of nothing but best-practice rules settles nothing at all', () => {
    const run = readAxeReport(report({ violations: [rule('region', REGION, 'moderate')], incomplete: [] }));
    assert.equal(run.criteriaCovered.size, 0);
    assert.equal(stillNotChecked(run.rulesRun).length, NOT_CHECKED.length);
  });
});
