// Unit tests for the DECIDE step and the role views on hand-built items. They check routing
// and completeness, not whether a real person finds the views useful.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide } from '../../engine/decide.ts';
import type { Diagnosis, DiagnosisCategory } from '../../reporters/types.ts';
import { componentOf, type TriageItem } from '../items.ts';
import { missingFromView } from '../view.ts';
import { prCommentView } from '../views/developer.ts';
import { groupEnv, infraView } from '../views/infra.ts';
import { releaseView } from '../views/release.ts';
import { sdetBoardView } from '../views/sdet.ts';

function diagnosis(category: DiagnosisCategory, confidence = 0.8, extra: Partial<Diagnosis> = {}): Diagnosis {
  return { category, confidence, source: 'rules', engineVersion: 'rules-2', diagnosedAt: '2026-01-01T00:00:00Z', evidence: [{ source: 'x', message: `because ${category}` }], ...extra };
}

function item(category: DiagnosisCategory, overrides: Partial<TriageItem> = {}, confidence = 0.8): TriageItem {
  const d = overrides.diagnosis ?? diagnosis(category, confidence);
  return {
    runId: 'r1',
    testId: `chromium > editor/blocks/image.spec.js > ${category} test`,
    title: `${category} test`,
    file: 'editor/blocks/image.spec.js',
    component: 'editor/blocks',
    commit: 'abcdef1234',
    timestamp: '2026-01-01T00:00:00Z',
    failedAttempts: 1,
    wastedMs: 1000,
    errorHead: 'Error: x',
    diagnosis: d,
    action: decide(d),
    source: 'rules rules-2 · data: test',
    evidence: d.evidence.map((e) => e.message),
    recoveredOnRetry: false,
    relation: { verdict: 'unclear', why: 'n/a' },
    debt: [],
    ...overrides,
  };
}

describe('decide (ROADMAP autonomy table)', () => {
  it('maps each category to its action and owner', () => {
    assert.equal(decide(diagnosis('ENV', 0.6)).kind, 'rerun-and-notify');
    assert.equal(decide(diagnosis('ENV', 0.6)).autonomous, true);
    assert.equal(decide(diagnosis('REAL_BUG')).owner, 'developer');
    assert.equal(decide(diagnosis('TEST_DATA')).autonomous, false);
  });

  it('only lets the agent fix code above 0.85', () => {
    assert.equal(decide(diagnosis('LOCATOR_DRIFT', 0.9)).autonomous, true);
    assert.equal(decide(diagnosis('LOCATOR_DRIFT', 0.8)).autonomous, false);
    assert.equal(decide(diagnosis('TIMING', 0.95), { hardWait: 'await page.waitForTimeout(500)' }).autonomous, true);
    assert.equal(decide(diagnosis('TIMING', 0.95)).autonomous, false, 'no hard wait: nothing safe to rewrite');
  });

  it('escalates UNKNOWN and weak diagnoses to a human', () => {
    assert.equal(decide(diagnosis('UNKNOWN', 0)).kind, 'escalate');
    assert.equal(decide(diagnosis('REAL_BUG', 0.3)).kind, 'escalate');
  });

  it('puts the suggested locator into a drift fix', () => {
    const a = decide(diagnosis('LOCATOR_DRIFT', 0.9), { locator: "locator('#pay')", suggestedLocator: "getByRole('button', { name: 'Pay now' })" });
    assert.match(a.summary, /getByRole\('button', \{ name: 'Pay now' \}\)/);
  });
});

describe('views', () => {
  const items = [item('REAL_BUG', { relation: { verdict: 'likely-this-change', why: 'every attempt on this commit failed' } }), item('ENV'), item('TIMING', { recoveredOnRetry: true }), item('UNKNOWN', {}, 0)];

  it('every item is complete in the views its category routes to', () => {
    const views = [prCommentView(items, 'r1', 'test'), sdetBoardView(items, 'r1', 'test'), infraView(items, 'r1', 'test'), releaseView(items, 'r1', 'test')];
    assert.equal(missingFromView(views[0], items[0]), null);
    assert.equal(missingFromView(views[1], items[3]), null);
    assert.equal(missingFromView(views[2], items[1]), null);
    assert.equal(missingFromView(views[3], items[0]), null);
  });

  it('the check catches a view that drops the confidence', () => {
    const view = sdetBoardView(items, 'r1', 'test');
    const broken = { ...view, markdown: view.markdown.replaceAll('confidence 0.80', 'confidence ?') };
    assert.match(missingFromView(broken, items[0]) ?? '', /confidence/);
  });

  it('the PR comment leads with failures likely caused by the change', () => {
    const md = prCommentView(items, 'r1', 'test').markdown;
    assert.ok(md.indexOf('Likely caused by this change') < md.indexOf('REAL_BUG test'));
    assert.match(md, /1 likely caused by this change/);
  });

  it('release readiness: a confident product bug blocks, an undecided one means wait', () => {
    assert.match(releaseView(items, 'r1', 'test').markdown, /NOT READY/);
    assert.match(releaseView([item('UNKNOWN', {}, 0), item('ENV')], 'r1', 'test').markdown, /WAIT/);
    assert.match(releaseView([item('ENV'), item('TIMING')], 'r1', 'test').markdown, /READY from a product point of view/);
  });

  it('infrastructure view groups ENV failures by what broke', () => {
    const net = (match: string) => item('ENV', { diagnosis: diagnosis('ENV', 0.9, { evidence: [{ source: 'env-network', message: 'm', data: { kind: 'connection', match } }] }) });
    const groups = groupEnv([net('socket hang up'), net('socket hang up'), net('ECONNREFUSED'), item('TIMING')]);
    assert.deepEqual(groups.map((g) => g.items.length), [2, 1]);
  });
});

describe('componentOf', () => {
  it('uses the first two folders of the spec path, or the spec name', () => {
    assert.equal(componentOf('editor/blocks/image.spec.js'), 'editor/blocks');
    assert.equal(componentOf('admin/font-library.spec.js'), 'admin');
    assert.equal(componentOf('tests/network.spec.ts'), 'network');
  });
});
