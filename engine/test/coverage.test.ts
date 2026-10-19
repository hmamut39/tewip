// Phase 53: reading a coverage report the project already produces.
//
// Everything else in Tewip follows imports to decide what a test reaches, and Phases 46 and 52 hit
// the same wall twice: a test that posts a GraphQL query never imports the resolver chain it runs
// through. `done` answered "cannot say" on every real Saleor pull request and `pick` refused to
// narrow - honest both times, useless to a Python or Rails team. A coverage report records what ran.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { describesThisProject, findCoverage, readLcov, readXml, wasExecuted } from '../coverage/read-coverage.ts';
import { decide, type Evidence } from '../verdict/verdict.ts';

describe('the four formats CI actually writes', () => {
  it('reads lcov, which is what a JavaScript or Rust suite leaves behind', () => {
    const text = 'TN:\nSF:engine/pick/pick.ts\nDA:1,1\nDA:2,0\nDA:3,4\nend_of_record\n';
    const { executed, mentioned } = readLcov(text);
    assert.deepEqual([...mentioned], ['engine/pick/pick.ts']);
    assert.deepEqual([...(executed.get('engine/pick/pick.ts') ?? [])], [1, 3], 'a line with no hits did not run');
  });

  it('reads Cobertura, which is what pytest-cov and coverlet write', () => {
    const xml = '<coverage><packages><package name="x"><classes><class filename="saleor/graphql/utils/sorting.py"><lines><line number="10" hits="3"/><line number="11" hits="0"/></lines></class></classes></package></packages></coverage>';
    const { executed } = readXml(xml);
    assert.deepEqual([...(executed.get('saleor/graphql/utils/sorting.py') ?? [])], [10]);
  });

  it('reads JaCoCo, and joins the package back onto the bare file name', () => {
    // JaCoCo names the package separately and the sourcefile without its directory. Without joining
    // them every file reads as a bare name that matches nothing in the diff.
    const xml = '<report><package name="org/keycloak/util"><sourcefile name="PemUtils.java"><line nr="41" mi="0" ci="4"/><line nr="42" mi="2" ci="0"/></sourcefile></package></report>';
    const { executed, mentioned } = readXml(xml);
    assert.deepEqual([...mentioned], ['org/keycloak/util/PemUtils.java']);
    assert.deepEqual([...(executed.get('org/keycloak/util/PemUtils.java') ?? [])], [41]);
  });

  it('reads Clover, which is what PHPUnit writes', () => {
    const xml = '<coverage><project><file path="src/Cart.php"><line num="8" type="stmt" count="2"/><line num="9" type="stmt" count="0"/></file></project></coverage>';
    const { executed } = readXml(xml);
    assert.deepEqual([...(executed.get('src/Cart.php') ?? [])], [8]);
  });
});

describe('a report that is not about this project', () => {
  it('is refused, rather than read as "nothing here is tested"', () => {
    // A stale report from another checkout would otherwise produce the confident wrong answer this
    // whole exercise exists to avoid: every changed file "in the report with no line executed".
    const root = mkdtempSync(join(tmpdir(), 'tewip-cov-'));
    writeFileSync(join(root, 'real.ts'), 'export const x = 1;\n');
    const elsewhere = readXml('<coverage><packages><package name="p"><classes><class filename="some/other/project/a.py"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>');
    assert.equal(describesThisProject({ from: 'coverage.xml', ...elsewhere }, root), false);
    const here = readXml('<coverage><packages><package name="p"><classes><class filename="real.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>');
    assert.equal(describesThisProject({ from: 'coverage.xml', ...here }, root), true);
  });

  it('finds the report where the tool that wrote it puts one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-cov-'));
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'src.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'coverage', 'lcov.info'), 'SF:src.ts\nDA:1,1\nend_of_record\n');
    const found = findCoverage(root);
    assert.equal(found?.from, 'coverage/lcov.info');
    assert.equal(wasExecuted(found!, 'src.ts'), true);
  });
});

describe('the verdict, once a coverage report is there', () => {
  const sound: Evidence = {
    changedSource: ['saleor/graphql/utils/sorting.py'],
    changedTests: ['saleor/graphql/product/tests/test_sorting.py'],
    covering: [],
    cannotFail: [],
    crashOnly: 0,
    couldNotJudge: 0,
    proofsTried: 1,
    proofSkipped: '',
    unnoticed: [],
    failingNow: [],
    noHistory: false,
    uncovered: [],
    brokenRules: [],
  };

  it('answers the question imports could not', () => {
    // On every real Saleor pull request this read "cannot say", because coverage was followed
    // through imports and the test reaches the code through a GraphQL resolver.
    const decision = decide({ ...sound, coverage: { from: 'coverage.xml', executed: ['saleor/graphql/utils/sorting.py'], notExecuted: [] } });
    const check = decision.checks.find((c) => c.question === 'Is the changed code tested?');
    assert.equal(check?.standing, 'met');
    assert.match(check?.answer ?? '', /the suite executes/);
    assert.match(check?.decidedBy ?? '', /records what ran rather than what imports what/);
  });

  it('says not ready when the report shows the code never running', () => {
    const decision = decide({ ...sound, coverage: { from: 'coverage.xml', executed: [], notExecuted: ['saleor/graphql/utils/sorting.py'] } });
    assert.equal(decision.verdict, 'not-ready');
    assert.match(decision.headline, /no line executed/);
  });

  it('falls back to "cannot say" when there is no report at all', () => {
    const decision = decide(sound);
    const check = decision.checks.find((c) => c.question === 'Is the changed code tested?');
    assert.equal(check?.standing, 'not-checked');
  });
});
