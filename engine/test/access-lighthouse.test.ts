// Phase 32: a Lighthouse report read as accessibility evidence.
//
// Lighthouse runs axe rules and reports them by their axe ids, but strips axe's tags - so the
// report says `landmark-one-main` and nothing about whether that is a WCAG failure or one of axe's
// own suggestions. That distinction decides whether a team is handed a legal problem or a tidy-up,
// and it covers 30 of axe's 105 rules, so getting it from a remembered table was not acceptable.
// axe-rules.ts is generated from axe-core itself; these tests check it is actually being used and
// that the three verdicts come out the same as they do from a live axe run.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AXE_CORE_VERSION, AXE_RULES, factsFor } from '../access/axe-rules.ts';
import { accessibilityFromLighthouse, criteriaFromLighthouse, rulesRunByLighthouse } from '../access/from-lighthouse.ts';
import { readLighthouse } from '../perf/lighthouse.ts';
import { readBrowserRun } from '../access/access-command.ts';
import { stillNotChecked } from '../access/merge.ts';
import { renderAccess } from '../access/render.ts';

function a11yAudit(id: string, score: number | null, mode = 'binary', nodes: unknown[] = []) {
  return {
    id,
    title: `${id} title`,
    score,
    scoreDisplayMode: mode,
    ...(nodes.length > 0 ? { details: { type: 'table', items: nodes } } : {}),
  };
}

const nodeItem = (selector: string, snippet: string, explanation: string) => ({ node: { selector, snippet, explanation } });

function lighthouse(a11y: Array<ReturnType<typeof a11yAudit>>) {
  const audits: Record<string, unknown> = {};
  for (const a of a11y) audits[a.id] = a;
  return {
    lighthouseVersion: '13.5.0',
    fetchTime: '2026-10-11T12:00:00.000Z',
    finalDisplayedUrl: 'http://example.test/',
    audits,
    categories: { accessibility: { score: 0.9, auditRefs: a11y.map((a) => ({ id: a.id })) } },
  };
}

function file(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tewip-lh-a11y-')), 'lh.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

describe('the table generated from axe-core', () => {
  it('covers every rule axe ships, and partitions them cleanly', () => {
    const ids = Object.keys(AXE_RULES);
    assert.equal(ids.length, 105, 'axe-core 4.14.0 ships 105 rules');
    assert.equal(AXE_CORE_VERSION, '4.14.0');
    const withCriterion = ids.filter((id) => AXE_RULES[id].criterion !== null);
    assert.equal(withCriterion.length, 75);
    // Every rule is either a standard or explicitly not one. None is unclassified, which is what
    // makes "advice" a safe verdict rather than a guess about rules the table did not know.
    for (const id of ids) {
      const f = AXE_RULES[id];
      if (f.criterion === null) assert.equal(f.level, null, `${id} has a level but no criterion`);
      else assert.match(f.criterion, /^\d+\.\d+\.\d+$/, id);
    }
  });

  it('agrees with the tags a live axe run carries', () => {
    // These were read off real axe 4.14 output in Phase 29, from runs against real pages.
    assert.deepEqual(factsFor('color-contrast'), { criterion: '1.4.3', level: 'AA', en301549: '9.1.4.3' });
    assert.deepEqual(factsFor('label'), { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' });
    assert.deepEqual(factsFor('nested-interactive'), { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' });
    assert.deepEqual(factsFor('meta-viewport'), { criterion: '1.4.4', level: 'AA', en301549: '9.1.4.4' });
    // And the best-practice ones that made 42% of a real run's output.
    assert.equal(factsFor('region')?.criterion, null);
    assert.equal(factsFor('landmark-one-main')?.criterion, null);
    assert.equal(factsFor('heading-order')?.criterion, null);
  });

  it('knows nothing about a rule axe does not have', () => {
    assert.equal(factsFor('not-a-real-rule'), undefined);
  });
});

describe('reading a Lighthouse report as accessibility evidence', () => {
  it('a failing audit for a real criterion is a barrier, with the criterion attached', () => {
    const r = readLighthouse(file(lighthouse([a11yAudit('label', 0, 'binary', [nodeItem('#email', '<input id="email">', 'Fix: Form elements do not have labels')])])));
    const [finding] = accessibilityFromLighthouse(r);
    assert.equal(finding.confidence, 'barrier');
    assert.equal(finding.criterion, '4.1.2');
    assert.equal(finding.level, 'A');
    assert.equal(finding.en301549, '9.4.1.2');
    assert.equal(finding.selector, '#email');
  });

  it('a failing audit for a best-practice rule is advice, never a barrier', () => {
    const r = readLighthouse(file(lighthouse([a11yAudit('landmark-one-main', 0, 'binary', [nodeItem('html', '<html>', 'no main landmark')])])));
    const [finding] = accessibilityFromLighthouse(r);
    assert.equal(finding.confidence, 'advice');
    assert.equal(finding.criterion, null);
    assert.equal(finding.severity, 'minor', 'advice must never be able to fail a build');
  });

  it('an audit Lighthouse refuses to score becomes a question, not a pass', () => {
    const r = readLighthouse(file(lighthouse([a11yAudit('logical-tab-order', null, 'manual')])));
    const [finding] = accessibilityFromLighthouse(r);
    assert.equal(finding.confidence, 'ask-a-person');
    assert.match(finding.why, /does not score this one/);
  });

  it('severity follows the WCAG level, since Lighthouse reports no impact', () => {
    const levelA = readLighthouse(file(lighthouse([a11yAudit('label', 0, 'binary', [nodeItem('#a', '<input>', 'x')])])));
    const levelAA = readLighthouse(file(lighthouse([a11yAudit('color-contrast', 0, 'binary', [nodeItem('#b', '<p>', 'x')])])));
    assert.equal(accessibilityFromLighthouse(levelA)[0].severity, 'blocker', 'level A is the most basic requirement');
    assert.equal(accessibilityFromLighthouse(levelAA)[0].severity, 'serious');
  });

  it('counts every audit that ran, including the ones that passed', () => {
    const r = readLighthouse(
      file(lighthouse([a11yAudit('color-contrast', 1), a11yAudit('label', 0, 'binary', [nodeItem('#a', '<input>', 'x')]), a11yAudit('image-alt', null, 'notApplicable')])),
    );
    const ran = rulesRunByLighthouse(r);
    assert.ok(ran.has('color-contrast'), 'a rule that passed was still checked');
    assert.ok(ran.has('image-alt'), 'a rule that did not apply was still checked');
    assert.ok(criteriaFromLighthouse(r).has('1.4.3'));
  });

  it('a Lighthouse run moves contrast off the list of things Tewip could not check', () => {
    const r = readLighthouse(file(lighthouse([a11yAudit('color-contrast', 1)])));
    const remaining = stillNotChecked(rulesRunByLighthouse(r)).map((n) => n.criterion);
    assert.ok(!remaining.some((c) => c.startsWith('1.4.3')), 'contrast was checked by the run');
    assert.ok(remaining.some((c) => c.startsWith('1.1.1')), 'alt-text quality still cannot be settled by any tool');
  });
});

describe('one command, either tool', () => {
  it('reads a Lighthouse report and says it was Lighthouse', () => {
    const run = readBrowserRun(file(lighthouse([a11yAudit('label', 0, 'binary', [nodeItem('#a', '<input>', 'x')])])));
    assert.equal(run.source, 'lighthouse');
    assert.equal(run.findings.length, 1);
    assert.deepEqual([...run.pages], ['http://example.test/']);
  });

  it('still reads an axe report, and says it was axe', () => {
    const axe = file({
      url: 'http://example.test/',
      violations: [{ id: 'label', impact: 'critical', tags: ['wcag2a', 'wcag412', 'EN-301-549', 'EN-9.4.1.2'], help: 'labels', nodes: [{ html: '<input>', target: ['#a'], failureSummary: 'Fix: no label' }] }],
      incomplete: [],
      passes: [],
    });
    const run = readBrowserRun(axe);
    assert.equal(run.source, 'axe');
    assert.equal(run.findings[0].criterion, '4.1.2');
  });
});

// Phase 68: field-tested with real Lighthouse accessibility runs over six real pages - gov.uk, MDN,
// Hacker News, python.org, w3.org/WAI and Wikipedia. The findings themselves were right and
// checkable by hand. The summary line was not.
describe('the one line a reader actually reads', () => {
  const finding = (rule: string, severity: 'blocker' | 'serious' = 'blocker') =>
    ({ rule, severity, selector: 'div', html: '<div>', why: 'because', criterion: '1.1.1', level: 'A' }) as never;
  const browser = (barriers: unknown[], questions: unknown[] = [], advice: unknown[] = []) =>
    ({ tool: 'lighthouse' as const, pages: ['https://example.com'], barriers, questions, advice, superseded: [], ranRules: new Set<string>() }) as never;
  const result = (over: Record<string, unknown>) =>
    ({ barriers: [], questions: [], accepted: [], filesRead: 0, ...over }) as never;

  it('counts barriers as rules and says in how many places', () => {
    // Hacker News came back as "244 barriers", of which 238 were one rule - colour contrast - on one
    // page. Arithmetically right and useless: five things are wrong here, one of them in 238 places.
    const many = [...Array(238)].map(() => finding('color-contrast')).concat([finding('image-alt'), finding('label')]);
    const report = renderAccess(result({ browser: browser(many) }), '/project');
    assert.match(report, /\*\*3 barriers the browser run proves, in 240 places/);
  });

  it('does not print two different counts both called barriers', () => {
    // "244 barriers the browser run proves, 0 barriers (0 that stop somebody outright)" - a reader
    // cannot tell whether the second number corrects the first. With no markup read there is no
    // markup count to give: zero files examined is not a finding of zero.
    const report = renderAccess(result({ browser: browser([finding('label')]) }), '/project');
    const headline = report.split(String.fromCharCode(10)).find((l) => l.startsWith('**')) ?? '';
    assert.doesNotMatch(headline, /barriers.*barriers/, 'one sentence, one meaning of the word');
    assert.doesNotMatch(headline, /0 barrier/, 'nothing was read, so nothing is reported as zero');
  });

  it('still reports the markup count when markup really was read', () => {
    const report = renderAccess(result({ filesRead: 12, barriers: [finding('image-alt')], browser: browser([]) }), '/project');
    const headline = report.split(String.fromCharCode(10)).find((l) => l.startsWith('**')) ?? '';
    assert.match(headline, /no barrier in the browser run/);
    assert.match(headline, /1 barrier in the markup/, 'and says which half it came from');
  });

  it('says nothing was checked when no markup was read and no browser run was given', () => {
    const report = renderAccess(result({ questions: [finding('x')] }), '/project');
    assert.match(report, /no markup file was read, so nothing was checked/);
  });
});
