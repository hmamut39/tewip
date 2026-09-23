// Robot Framework, JMeter and k6. Every shape below was taken from a real report published in a
// public repository - Robot's own timestamp format, JMeter's grouped samples, and both of the two
// shapes k6 has used for its summary.
//
// The last test in this file is not about formats at all: it guards the repository against a stray
// control character, which slipped into source three times in one day through a shell heredoc and
// each time made a regular expression quietly never match.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseXml } from '../import/xml.ts';
import { jmeterCases, k6Cases, looksLikeK6, robotCases, robotTime } from '../import/other-formats.ts';

const NL = String.fromCharCode(10);
const xml = (...lines: string[]) => parseXml(lines.join(NL));

describe('Robot Framework', () => {
  const report = xml(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<robot generated="20180303 09:46:00.211" generator="Robot 3.0.2">',
    '<suite source="C:\\tests\\batch.robot" id="s1" name="batch Request">',
    '<test id="s1-t1" name="creates a batch">',
    '<kw name="Open Browser"><status status="PASS"/></kw>',
    '<kw name="Element Should Contain"><status status="FAIL"/></kw>',
    '<status status="FAIL" starttime="20180303 09:46:00.211" endtime="20180303 09:46:02.711">Element should have contained "Done" but was "Pending"</status>',
    '</test>',
    '<test id="s1-t2" name="lists batches">',
    '<status status="PASS" starttime="20180303 09:46:03.000" endtime="20180303 09:46:03.500"/>',
    '</test>',
    '</suite>',
    '</robot>',
  );

  it('reads a failing test, its message and the keyword that failed', () => {
    const cases = robotCases(report);
    assert.equal(cases.length, 2);
    const failed = cases.find((c) => c.attempts[0].failed)!;
    assert.equal(failed.testId, 'batch Request > creates a batch');
    assert.match(failed.attempts[0].message, /Element should have contained "Done" but was "Pending"/);
    assert.match(failed.attempts[0].stack, /Keyword: Element Should Contain/);
    assert.equal(failed.duration, 2500, "Robot's own timestamp format, turned into milliseconds");
  });

  it('leaves the passing test alone', () => {
    const passed = robotCases(report).find((c) => c.testId.endsWith('lists batches'))!;
    assert.equal(passed.attempts[0].failed, false);
    assert.equal(passed.attempts[0].message, '');
  });

  it('turns Robot\'s timestamp into a real one, and refuses anything else', () => {
    assert.equal(robotTime('20180303 09:46:00.211'), '2018-03-03T09:46:00.211Z');
    assert.equal(robotTime('not a timestamp'), '', 'handing this to a date would throw');
  });
});

describe('JMeter', () => {
  const report = xml(
    '<testResults version="1.2">',
    '<httpSample t="83" s="false" lb="HTTP Request" rc="200" rm="OK">',
    '<assertionResult><name>Duration</name><failureMessage>The operation lasted too long: It took 83 milliseconds</failureMessage></assertionResult>',
    '</httpSample>',
    '<httpSample t="40" s="true" lb="HTTP Request" rc="200" rm="OK"/>',
    '<httpSample t="20" s="false" lb="Checkout" rc="503" rm="Service Unavailable"/>',
    '</testResults>',
  );

  it('groups thousands of samples into one line per request', () => {
    const cases = jmeterCases(report);
    assert.equal(cases.length, 2, 'one per label, not one per sample');
    const http = cases.find((c) => c.testId.endsWith('HTTP Request'))!;
    assert.equal(http.duration, 123, 'the time of every sample with that label');
    assert.match(http.attempts[0].message, /1 of 2 requests failed/);
  });

  it('says an assertion failed rather than "mostly 200", which reads as nonsense', () => {
    const http = jmeterCases(report).find((c) => c.testId.endsWith('HTTP Request'))!;
    assert.match(http.attempts[0].message, /an assertion failed \(1 times, response 200 OK\)/);
    assert.match(http.attempts[0].message, /The operation lasted too long/);
  });

  it('names the server error when it really was one', () => {
    const checkout = jmeterCases(report).find((c) => c.testId.endsWith('Checkout'))!;
    assert.match(checkout.attempts[0].message, /mostly 503 Service Unavailable/);
  });
});

describe('k6', () => {
  // The newer shape: numbers under "values", thresholds as objects.
  const modern = {
    metrics: {
      'http_req_duration{scenario:checkout}': {
        type: 'trend',
        values: { avg: 55.7, 'p(95)': 1312.8, max: 1400 },
        thresholds: { 'p(95)<1200': { ok: false } },
      },
      http_req_failed: { type: 'rate', values: { rate: 0, passes: 0, fails: 79 }, thresholds: { 'rate<0.01': { ok: true } } },
    },
  };
  // The older shape: numbers on the metric, thresholds as plain booleans.
  const older = { metrics: { http_req_duration: { avg: 12.4, 'p(95)': 28, thresholds: { 'p(95)<500': true } }, http_reqs: { count: 27_000 } } };

  it('reports a crossed threshold, with what was actually measured', () => {
    const cases = k6Cases(modern);
    const crossed = cases.filter((c) => c.attempts[0].failed);
    assert.equal(crossed.length, 1);
    assert.match(crossed[0].testId, /p\(95\)<1200/);
    assert.match(crossed[0].attempts[0].message, /threshold "p\(95\)<1200" on http_req_duration\{scenario:checkout\} was crossed/);
    assert.match(crossed[0].attempts[0].message, /p\(95\)=1312\.80/, 'the number that crossed it is in the message');
  });

  it('reads both shapes k6 has used, and reports nothing when nothing was crossed', () => {
    assert.deepEqual(k6Cases(older).filter((c) => c.attempts[0].failed), []);
    assert.equal(k6Cases(older).length, 1, 'one threshold was checked');
  });

  it('will not read some other JSON file as a performance summary', () => {
    assert.equal(looksLikeK6({ metrics: { http_req_duration: {} } }), true);
    assert.equal(looksLikeK6({ metrics: { coverage: 91 } }), false);
    assert.equal(looksLikeK6({ name: 'package.json', version: '1.0.0' }), false);
  });
});

describe('the source itself', () => {
  it('contains no stray control characters', () => {
    // A shell heredoc turned "\\b" into a real backspace three times in one day. Each time the
    // regular expression around it silently stopped matching, and each time it took a measurement
    // against real data to notice. This is cheaper.
    const forbidden = new Set([8, 7, 11, 12].map((code) => String.fromCharCode(code)));
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.tewip', 'data', 'fixtures']);
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(?:ts|md|json|yml)$/.test(entry)) continue;
        const source = readFileSync(path, 'utf8');
        for (const ch of forbidden) {
          if (source.includes(ch)) bad.push(`${path} (0x${ch.charCodeAt(0).toString(16)})`);
        }
      }
    };
    walk(join(import.meta.dirname, '..', '..'));
    assert.deepEqual(bad, [], `these files hold a control character that will break a regular expression: ${bad.join(', ')}`);
  });
});
