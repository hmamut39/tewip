// Unit tests for the DECIDE step and the role views on hand-built items. They check routing
// and completeness, not whether a real person finds the views useful.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide } from '../../engine/decide.ts';
import type { Diagnosis, DiagnosisCategory } from '../../reporters/types.ts';
import { componentOf, type TriageItem } from '../items.ts';
import { clean, missingFromView } from '../view.ts';
import { commentOrder, prCommentView } from '../views/developer.ts';
import { groupEnv, infraView } from '../views/infra.ts';
import { releaseView } from '../views/release.ts';
import { qualityView } from '../views/quality.ts';
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
    branch: 'main',
    onDefaultBranch: true,
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

  it('only lets the agent fix a locator above 0.85 and with a deterministic element match', () => {
    assert.equal(decide(diagnosis('LOCATOR_DRIFT', 0.9, { ruleId: 'locator-drift' })).autonomous, true);
    assert.equal(decide(diagnosis('LOCATOR_DRIFT', 0.8, { ruleId: 'locator-drift' })).autonomous, false);
    assert.equal(decide(diagnosis('LOCATOR_DRIFT', 0.95, { source: 'llm' })).autonomous, false, 'AI-only drift goes to a person');
    assert.equal(decide(diagnosis('TIMING', 0.95), { hardWait: 'await page.waitForTimeout(500)' }).autonomous, true);
    assert.equal(decide(diagnosis('TIMING', 0.95)).autonomous, false, 'no hard wait: nothing safe to rewrite');
  });

  it('escalates UNKNOWN and weak diagnoses to a human', () => {
    assert.equal(decide(diagnosis('UNKNOWN', 0)).kind, 'escalate');
    assert.equal(decide(diagnosis('REAL_BUG', 0.3)).kind, 'escalate');
  });

  it('puts the suggested locator into a drift fix', () => {
    const a = decide(diagnosis('LOCATOR_DRIFT', 0.9, { ruleId: 'locator-drift' }), { locator: "locator('#pay')", suggestedLocator: "getByRole('button', { name: 'Pay now' })" });
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

describe('decide: strict-mode locators', () => {
  it('asks to narrow a locator that now matches several elements instead of renaming it', () => {
    const a = decide(diagnosis('LOCATOR_DRIFT', 0.95, { source: 'llm' }), { locator: "getByRole('status')", strictMatches: 2 });
    assert.match(a.summary, /more specific: it now matches 2 elements/);
  });
});

describe('quality view: quarantine candidates', () => {
  const flaky = (testId: string, runId: string, wastedMs: number) => item('TIMING', { testId, runId, wastedMs, file: 'a.spec.ts' });

  it('names the flaky tests that cost the most, once they flaked in more than one run', () => {
    const md = qualityView(
      [
        flaky('chromium > a.spec.ts > slow one', 'r1', 120_000),
        flaky('chromium > a.spec.ts > slow one', 'r2', 120_000),
        flaky('chromium > a.spec.ts > cheap one', 'r1', 1_000),
        flaky('chromium > a.spec.ts > cheap one', 'r2', 1_000),
        flaky('chromium > a.spec.ts > only once', 'r1', 500_000),
      ],
      'test',
    ).markdown;
    const rows = md.split('## Quarantine candidates')[1].split('## Recurring')[0];
    assert.match(rows, /slow one.*\| 2 \| 4\.0 CI min/);
    assert.ok(rows.indexOf('slow one') < rows.indexOf('cheap one'), 'ranked by CI time lost');
    assert.ok(!rows.includes('only once'), 'a test that flaked in one run only is not listed');
  });

  it('keeps rows telling apart when two tests share a name', () => {
    const md = qualityView(
      [
        flaky('firefox > a.spec.ts > Replicator', 'r1', 2_000),
        flaky('firefox > a.spec.ts > Replicator', 'r2', 2_000),
        flaky('chromium > a.spec.ts > Replicator', 'r1', 1_000),
        flaky('chromium > a.spec.ts > Replicator', 'r2', 1_000),
      ],
      'test',
    ).markdown;
    assert.match(md, /firefox > a\.spec\.ts > Replicator/);
    assert.match(md, /chromium > a\.spec\.ts > Replicator/);
  });
});

describe('PR comment: failures that share one cause', () => {
  it('says so up front when three or more failures share a category and an error', () => {
    const outage = (n: number) => item('ENV', { testId: `t${n}`, title: `t${n}`, errorHead: 'Error: connect ECONNREFUSED 10.0.0.5:5432' });
    const md = prCommentView([outage(1), outage(2), outage(3), item('REAL_BUG')], 'r1', 'test').markdown;
    assert.match(md, /3 failures look like one cause\*\* \(ENV, same error\): `Error: connect ECONNREFUSED 10\.0\.0\.5:5432`/);
  });

  it('does not group timeouts on different elements: each is its own problem', () => {
    const drift = (n: number) => item('LOCATOR_DRIFT', { testId: `d${n}`, title: `d${n}`, errorHead: 'TimeoutError: locator.click: Timeout 10000ms exceeded.', locator: `#button-${n}` });
    const md = prCommentView([drift(1), drift(2), drift(3)], 'r1', 'test').markdown;
    assert.doesNotMatch(md, /look like one cause/);
  });

  it('never groups undecided failures: their cause is not known', () => {
    const unknown = (n: number) => item('UNKNOWN', { testId: `u${n}`, title: `u${n}`, errorHead: 'Error: something' }, 0);
    assert.doesNotMatch(prCommentView([unknown(1), unknown(2), unknown(3)], 'r1', 'test').markdown, /look like one cause/);
  });
});

describe('comment text from a test run is made safe', () => {
  it('stops pings, links, images and HTML while keeping the text readable', () => {
    const out = clean('fails for @octocat ![x](https://evil/p.png) [click](https://evil) <img src=x>');
    assert.doesNotMatch(out, /@octocat/, 'no live mention');
    assert.match(out, /@​octocat/);
    assert.doesNotMatch(out, /\]\(https/, 'no live link or image');
    assert.doesNotMatch(out, /<img/, 'no raw HTML');
  });
});

describe('PR comment numbering', () => {
  it('shows each failure its number, in the order the hidden map uses', () => {
    const later = item('TIMING', { testId: 'b', title: 'second shown', relation: { verdict: 'not-this-change', why: 'x' } });
    const first = item('REAL_BUG', { testId: 'a', title: 'first shown', relation: { verdict: 'likely-this-change', why: 'x' } });
    const md = prCommentView([later, first], 'r1', 'test').markdown;
    assert.match(md, /\*\*#1\*\* \*\*first shown\*\*/);
    assert.match(md, /\*\*#2\*\* \*\*second shown\*\*/);
    assert.deepEqual(commentOrder([later, first]).map((i) => i.title), ['first shown', 'second shown']);
  });
});

