// Unit tests for `tewip plan`: the facts it reads from a project, and that the model's claims are
// checked against them rather than trusted.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { existingTests } from '../quality/grounding.ts';
import { verifyCoverage, type Plan, type PlanFacts } from '../quality/plan.ts';
import { renderPlan } from '../quality/plan-render.ts';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-plan-'));
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'e2e'));
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'e2e', 'shop.spec.ts'), "test('adds to cart', async () => {});\nit(\"removes an item\", () => {});\n");
  writeFileSync(join(root, 'tests', 'test_cart.py'), 'def test_total():\n    pass\n');
  writeFileSync(join(root, 'ShopTest.java'), '@Test\n  void paysWithCard() {}\n');
  writeFileSync(join(root, 'node_modules', 'x', 'ignored.test.js'), "test('not ours', () => {});\n");
  return root;
}

describe('reading the existing tests of a project', () => {
  it('finds test names across languages and skips installed packages', () => {
    const found = existingTests(project());
    assert.equal(found.files, 3);
    assert.deepEqual(found.tests.sort(), ['ShopTest.java: paysWithCard', 'e2e/shop.spec.ts: adds to cart', 'e2e/shop.spec.ts: removes an item', 'tests/test_cart.py: test_total']);
  });
});

const facts: PlanFacts = { feature: 'cart', change: null, pages: [], pagesNote: null, tests: { files: 1, tests: ['e2e/shop.spec.ts: adds to cart'] }, testSources: [{ file: 'test/query.test.ts', content: "{ input: '/?foo=1', query: { foo: undefined }, out: '/' }," }], history: [] };
const scenario = (id: string, covered_by: string) => ({ id, title: `scenario ${id}`, type: 'functional', priority: 'P0' as const, preconditions: '', steps: ['do it'], expected: 'it works', automate: true, covered_by, grounded_on: 'feature' });
const plan = (scenarios: Plan['scenarios']): Plan => ({ title: 'Cart', summary: 's', scope: [], out_of_scope: [], risks: [], scenarios, open_questions: [] });

describe("checking the model's coverage claims", () => {
  it('keeps a claim that names a real test, and drops one that does not', () => {
    const checked = verifyCoverage(plan([scenario('A', 'e2e/shop.spec.ts: adds to cart'), scenario('B', 'No existing test confirms this')]), facts);
    assert.equal(checked.scenarios[0].covered_by, 'e2e/shop.spec.ts: adds to cart');
    assert.equal(checked.scenarios[1].covered_by, '');
    assert.match(checked.scenarios[1].grounded_on, /related, not a full cover: No existing test confirms this/);
  });

  it('lists only truly uncovered, automatable scenarios under "To automate next"', () => {
    const md = renderPlan(verifyCoverage(plan([scenario('A', 'e2e/shop.spec.ts: adds to cart'), scenario('B', 'made up')]), facts), facts, 'test-model');
    const next = md.split('## To automate next')[1];
    assert.match(next, /B scenario B/);
    assert.doesNotMatch(next, /A scenario A/);
  });
});

describe('coverage by a case in a table-driven test', () => {
  it('keeps a cited case that is in the file, and drops one that is not', () => {
    const real = "test/query.test.ts: { input: '/?foo=1', query: { foo: undefined }, out: '/' }";
    const made = "test/query.test.ts: { input: '/?bar=2', query: { bar: undefined }, out: '/' }";
    const checked = verifyCoverage(plan([scenario('A', real), scenario('B', made)]), facts);
    assert.equal(checked.scenarios[0].covered_by, real);
    assert.equal(checked.scenarios[1].covered_by, '');
  });

  it('reads the test files that mention the feature most, code-like words first', async () => {
    const { relatedTestSources } = await import('../quality/grounding.ts');
    const root = project();
    writeFileSync(join(root, 'tests', 'test_query.py'), 'def test_with_query():\n    assert with_query("/", {"a": 1}) == "/?a=1"\n');
    const found = relatedTestSources(root, 'with_query adds parameters to a cart URL');
    assert.equal(found[0].file, 'tests/test_query.py');
  });
});
