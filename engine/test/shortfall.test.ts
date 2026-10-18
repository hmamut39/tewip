// Does a report hold the run it says it holds?
//
// Found by handing `tewip explain` four damaged reports. Two were refused correctly - an empty file
// and a pom.xml. The other two were not:
//
//   a report whose header read tests="500" failures="37", holding one passing testcase, came back
//   as **"All 1 test(s) passed. Nothing to explain."**
//
//   a report cut off mid-<failure> parsed without complaint, and Tewip spent a real model call
//   producing a confident REAL_BUG diagnosis of the one failure that survived the cut, never
//   mentioning that the suite's own header declared three tests and two failures.
//
// A truncated artifact is the commonest corruption in CI there is, and both answers were the exact
// failure this project exists to remove: a clean report produced by reading a fragment.
//
// Two signals, because neither covers the other. Reports that write their totals up front (Maven,
// pytest, PHPUnit, Jest) can be caught disagreeing with themselves. A streaming writer like
// node:test puts each suite's totals in its closing tag, so a cut file loses the tests and the count
// of them together - what it cannot hide is the element it never closed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importJunit } from '../import/junit.ts';
import { parseXml } from '../import/xml.ts';
import { shortfall } from '../import/shortfall.ts';

const NL = String.fromCharCode(10);
const check = (xml: string) => shortfall(parseXml(xml));

describe('a report that does not hold what it claims', () => {
  it('catches a header claiming far more than the body holds', () => {
    const said = check('<testsuites tests="500" failures="37"><testsuite name="cart" tests="500" failures="37"><testcase name="one" classname="cart"/></testsuite></testsuites>');
    assert.ok(said, 'a 500-test header over one testcase has to be reported');
    assert.match(said, /499 of the 500 test\(s\)/);
    assert.match(said, /37 of the 37 failure\(s\)/);
    assert.match(said, /fragment of its run/);
  });

  it('catches an element left open, with nothing else to go on', () => {
    // No totals anywhere: the only evidence is the tag that never closed.
    const said = check('<testsuites><testsuite name="cart"><testcase name="one" classname="cart"/>');
    assert.ok(said, 'an unclosed element is the one signal that needs no declared counts');
    assert.match(said, /ends in the middle of itself/);
  });

  it('reads the totals off the suites when the root carries none', () => {
    const said = check('<testsuites><testsuite name="a" tests="4" failures="1"><testcase name="one" classname="a"/></testsuite></testsuites>');
    assert.match(said ?? '', /3 of the 4 test\(s\)/);
    assert.match(said ?? '', /1 of the 1 failure\(s\)/);
  });

  it('counts errors as failures, which is what the attribute means', () => {
    const said = check('<testsuites><testsuite name="a" tests="2" errors="2"><testcase name="one" classname="a"/><testcase name="two" classname="a"/></testsuite></testsuites>');
    assert.match(said ?? '', /2 of the 2 failure\(s\)/);
  });
});

describe('a report that is whole', () => {
  it('says nothing about a suite whose numbers add up', () => {
    assert.equal(check('<testsuites tests="2" failures="1"><testsuite name="a" tests="2" failures="1"><testcase name="one" classname="a"><failure message="x">y</failure></testcase><testcase name="two" classname="a"/></testsuite></testsuites>'), null);
  });

  it('does not count a nested suite twice', () => {
    // PHPUnit wraps every suite in another suite carrying the same totals. Adding both levels read
    // real PHPUnit output as half missing - a false alarm on a good report, which is worse than the
    // silence it replaced.
    const phpunit = '<testsuites><testsuite name="CLI" tests="3" errors="1" failures="1"><testsuite name="ShopTest" tests="3" errors="1" failures="1">'
      + '<testcase name="a" classname="S"><failure message="x">y</failure></testcase>'
      + '<testcase name="b" classname="S"><error message="x">y</error></testcase>'
      + '<testcase name="c" classname="S"/></testsuite></testsuite></testsuites>';
    assert.equal(check(phpunit), null);
  });

  it('stays quiet when there are more testcases than declared', () => {
    // A rerun plugin writes an entry per attempt while `tests` counts the test once. More than
    // declared means a re-run, not a corrupt file, so only a shortfall is ever reported.
    assert.equal(check('<testsuites><testsuite name="a" tests="1"><testcase name="one" classname="a"><failure message="x">y</failure></testcase><testcase name="one" classname="a"/></testsuite></testsuites>'), null);
  });

  it('says nothing about a suite that declares nothing', () => {
    assert.equal(check('<testsuites><testsuite name="a"><testcase name="one" classname="a"/></testsuite></testsuites>'), null);
  });

  it('leaves every report a real runner wrote alone', () => {
    // The whole point. These were written by the runners themselves, by
    // .github/workflows/polyglot-fixtures.yml - dotnet, go, maven, jest, mocha, node:test, vitest,
    // phpunit, pytest, rspec and cargo-nextest.
    const files = [
      'dotnet-dotnet-junit.xml', 'go-go.xml', 'java-TEST-shop.ShopTest.xml', 'node-jest.xml',
      'node-mocha.xml', 'node-node-test.xml', 'node-vitest.xml', 'php-phpunit.xml',
      'python-pytest.xml', 'ruby-rspec.xml', 'rust-junit.xml',
    ];
    const complained: string[] = [];
    for (const name of files) {
      const said = check(readFileSync(`fixtures/polyglot/reports/${name}`, 'utf8'));
      if (said) complained.push(`${name}: ${said}`);
    }
    assert.deepEqual(complained, [], `a real report must never be called incomplete:${NL}${complained.join(NL)}`);
  });
});

describe('the parser tells the truth about what it read', () => {
  it('marks a document whose root never closed', () => {
    assert.equal(parseXml('<testsuites><testsuite name="a"/>').truncated, true);
  });

  it('does not mark a whole document', () => {
    assert.equal(parseXml('<testsuites><testsuite name="a"/></testsuites>').truncated, undefined);
  });

  it('does not mark a self-closed root', () => {
    assert.equal(parseXml('<testsuites/>').truncated, undefined);
  });
});

describe('the importer hands the warning on', () => {
  // `skippedShards` was the cautionary tale: the Playwright importer had detected corrupt shards
  // since it was written, recorded them faithfully, and nothing but the eval harness ever read the
  // field - so a run missing whole shards still rendered as a clean one. A detection nobody
  // surfaces is not a guard.
  const write = (xml: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'tewip-sf-'));
    const file = join(dir, 'report.xml');
    writeFileSync(file, xml, 'utf8');
    return file;
  };

  it('puts the reason in `incomplete`, named by file', () => {
    const file = write('<testsuites tests="500" failures="37"><testsuite name="cart" tests="500" failures="37"><testcase name="one" classname="cart"/></testsuite></testsuites>');
    const result = importJunit(file, { runId: 'r1', gitSha: '', workspace: '' });
    assert.equal(result.incomplete.length, 1);
    assert.match(result.incomplete[0], /^report\.xml: /);
    assert.match(result.incomplete[0], /499 of the 500 test\(s\)/);
  });

  it('leaves `incomplete` empty for a whole report', () => {
    const file = write('<testsuites tests="1" failures="0"><testsuite name="cart" tests="1" failures="0"><testcase name="one" classname="cart"/></testsuite></testsuites>');
    assert.deepEqual(importJunit(file, { runId: 'r1', gitSha: '', workspace: '' }).incomplete, []);
  });
});
