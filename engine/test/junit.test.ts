// Unit tests for the JUnit XML importer on report shapes written by different frameworks, and for
// the rules reaching the right answer from them. They check the import and the rules' logic, not
// accuracy on real CI data.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { diagnoseRecords } from '../engine.ts';
import { HistoryIndex } from '../history.ts';
import { importJunit } from '../import/junit.ts';
import { parseXml } from '../import/xml.ts';

function report(xml: string, name = 'report.xml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'triage-junit-'));
  writeFileSync(join(dir, name), xml, 'utf8');
  return dir;
}
const META = { runId: 'r1', gitSha: 'abc123' };

const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" timestamp="2026-09-19T10:00:00">
  <testcase classname="tests.test_cart.CartTests" name="test_total" time="0.012">
    <failure message="AssertionError: 3 != 4">Traceback (most recent call last):
  File "tests/test_cart.py", line 12, in test_total
    self.assertEqual(cart.total(), 4)
AssertionError: 3 != 4</failure>
  </testcase>
  <testcase classname="tests.test_cart.CartTests" name="test_empty" time="0.001"/>
  <testcase classname="tests.test_cart.CartTests" name="test_later" time="0"><skipped message="not yet"/></testcase>
</testsuite></testsuites>`;

describe('JUnit import', () => {
  it('reads a pytest report: the failure, the passes for history, and skips left out', () => {
    const { records, summary } = importJunit(report(PYTEST), META);
    assert.equal(records.length, 1);
    assert.equal(records[0].testId, 'tests.test_cart.CartTests > test_total');
    assert.match(records[0].errorMessage, /AssertionError: 3 != 4/);
    assert.match(records[0].errorStack, /File "tests\/test_cart.py", line 12/);
    assert.equal(records[0].duration, 12);
    assert.deepEqual(Object.keys(summary.attempts).sort(), ['tests.test_cart.CartTests > test_empty', 'tests.test_cart.CartTests > test_total']);
    assert.equal(summary.status, 'failed');
  });

  it('reads a Jest report, where the failure text has no message attribute', () => {
    const xml = `<testsuites name="jest tests"><testsuite name="Checkout" file="src/checkout.test.ts">
      <testcase classname="Checkout pays with card" name="Checkout pays with card" time="0.2"><failure><![CDATA[Error: expect(received).toBe(expected)

Expected: 4
Received: 3
    at Object.<anonymous> (src/checkout.test.ts:9:21)]]></failure></testcase></testsuite></testsuites>`;
    const [record] = importJunit(report(xml), META).records;
    assert.equal(record.testId, 'src/checkout.test.ts > Checkout pays with card');
    assert.equal(record.file, 'src/checkout.test.ts');
    assert.match(record.errorMessage, /Expected: 4\nReceived: 3/);
  });

  it('drops what is left of terminal colour codes, so the rules read the plain message', () => {
    const xml = `<testsuites><testsuite name="VotePill" file="components/VotePill.test.tsx">
      <testcase classname="VotePill" name="shows the score" time="0.1"><failure><![CDATA[Error: [2mexpect([22m[31melement[39m[2m).toHaveTextContent()[22m

Expected: [32m"12"[39m
Received: [31m"11"[39m]]></failure></testcase></testsuite></testsuites>`;
    const [record] = importJunit(report(xml), META).records;
    assert.match(record.errorMessage, /expect\(element\)\.toHaveTextContent\(\)/);
    assert.match(record.errorMessage, /Expected: "12"\nReceived: "11"/);
  });

  it('reads Maven Surefire retries: a flaky failure followed by a pass is two attempts, one failed', () => {
    const xml = `<testsuite name="com.shop.CheckoutTest"><testcase name="pays" classname="com.shop.CheckoutTest" time="1.5">
      <flakyFailure message="Read timed out" type="java.net.SocketTimeoutException"><stackTrace>java.net.SocketTimeoutException: Read timed out
	at com.shop.Client.get(Client.java:40)</stackTrace></flakyFailure></testcase></testsuite>`;
    const { records, summary } = importJunit(report(xml), META);
    assert.equal(records.length, 1);
    assert.equal(records[0].retry, 0);
    assert.equal(summary.attempts['com.shop.CheckoutTest > pays'], 2);
  });

  it('reads every .xml file in a directory as one run (Go, .NET and sharded runners write several)', () => {
    const dir = report(PYTEST, 'a.xml');
    writeFileSync(join(dir, 'b.xml'), `<testsuite name="github.com/acme/shop"><testcase classname="github.com/acme/shop" name="TestPay" time="0.01"><failure message="Failed">shop_test.go:12: got 3, want 4</failure></testcase></testsuite>`, 'utf8');
    const { records } = importJunit(dir, META);
    assert.deepEqual(records.map((r) => r.testId).sort(), ['github.com/acme/shop > TestPay', 'tests.test_cart.CartTests > test_total']);
  });

  it('decodes entities and keeps quoted ">" inside attributes', () => {
    const root = parseXml(`<testsuite><testcase name="a &gt; b" classname="x"><failure message="1 &lt; 2 is &quot;false&quot;">&#x41;&amp;B</failure></testcase></testsuite>`);
    const failure = root.children[0].children[0];
    assert.equal(root.children[0].attrs.name, 'a > b');
    assert.equal(failure.attrs.message, '1 < 2 is "false"');
    assert.equal(failure.text, 'A&B');
  });
});

describe('rules on non-Playwright failures', () => {
  const diagnose = (xml: string) => {
    const { records, summary } = importJunit(report(xml), META);
    return diagnoseRecords(records, new HistoryIndex(records, [summary]));
  };

  it('a refused connection in a Python traceback is ENV', () => {
    const [d] = diagnose(`<testsuite><testcase classname="tests.test_api" name="test_orders"><error message="requests.exceptions.ConnectionError">ConnectionRefusedError: [Errno 111] Connection refused</error></testcase></testsuite>`);
    assert.equal(d.category, 'ENV');
  });

  it('a unique-constraint violation is TEST_DATA', () => {
    const [d] = diagnose(`<testsuite><testcase classname="tests.test_users" name="test_signup"><failure message="IntegrityError">sqlite3.IntegrityError: UNIQUE constraint failed: users.email</failure></testcase></testsuite>`);
    assert.equal(d.category, 'TEST_DATA');
  });

  it('a Surefire test that failed and then passed on a retry is TIMING', () => {
    const [d] = diagnose(`<testsuite><testcase name="pays" classname="com.shop.CheckoutTest"><flakyFailure message="expected:&lt;4&gt; but was:&lt;3&gt;" type="org.opentest4j.AssertionFailedError"/></testcase></testsuite>`);
    assert.equal(d.category, 'TIMING');
    assert.equal(d.ruleId, 'timing-retry-pass');
  });
});
