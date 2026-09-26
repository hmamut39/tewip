// Phase 16: reading a production incident, and judging whether a test really reproduces it.
//
// The parsing tests use the shapes the tools actually emit. The judgement tests are the important
// ones: a test that fails is not a reproduction, and everything here exists to stop Tewip claiming
// otherwise.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { framesFromStack, ourFrames, readIncident } from '../incident/incident.ts';
import { judgeReproduction } from '../incident/reproduced.ts';

const NL = String.fromCharCode(10);
const lines = (...l: string[]) => l.join(NL);

describe('reading an incident', () => {
  it('reads a Sentry event, newest frame first', () => {
    const event = {
      event_id: 'abc',
      title: "TypeError: Cannot read properties of undefined (reading 'total')",
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'total')",
            stacktrace: {
              frames: [
                { abs_path: '/app/node_modules/express/lib/router.js', lineno: 10, function: 'handle' },
                { abs_path: '/app/src/checkout.ts', lineno: 42, function: 'computeTotal' },
              ],
            },
          },
        ],
      },
      request: { method: 'POST', url: 'https://shop.example/api/checkout' },
      datetime: '2026-09-20T10:00:00Z',
    };
    const incident = readIncident(JSON.stringify(event));
    assert.equal(incident.source, 'sentry');
    assert.equal(incident.errorType, 'TypeError');
    assert.equal(incident.operation, 'POST https://shop.example/api/checkout');
    assert.equal(incident.frames[0].file, '/app/src/checkout.ts', 'the newest frame first, as a person reads it');
    assert.deepEqual(ourFrames(incident).map((f) => f.file), ['/app/src/checkout.ts'], 'express is not our code');
  });

  it('reads an OpenTelemetry span that failed', () => {
    const span = {
      name: 'POST /api/checkout',
      status: { code: 'STATUS_CODE_ERROR' },
      events: [
        {
          name: 'exception',
          attributes: [
            { key: 'exception.type', value: { stringValue: 'ValueError' } },
            { key: 'exception.message', value: { stringValue: 'price must be positive' } },
            { key: 'exception.stacktrace', value: { stringValue: lines('  File "/app/pay.py", line 42, in charge', '    raise ValueError()') } },
          ],
        },
      ],
    };
    const incident = readIncident(JSON.stringify(span));
    assert.equal(incident.source, 'opentelemetry');
    assert.equal(incident.errorType, 'ValueError');
    assert.equal(incident.frames[0].file, '/app/pay.py');
    assert.equal(incident.frames[0].fn, 'charge');
  });

  it('reads a stack trace someone pasted, in any language', () => {
    const js = readIncident(lines('TypeError: total is not a function', '    at computeTotal (/app/src/cart.ts:17:9)', '    at /app/node_modules/x/index.js:3:1'));
    assert.equal(js.errorType, 'TypeError');
    assert.equal(js.source, 'stack trace');
    assert.equal(ourFrames(js).length, 1);

    const jvm = framesFromStack('\tat com.shop.Pay.charge(Pay.java:42)');
    assert.deepEqual(jvm, [{ file: 'Pay.java', line: 42, fn: 'com.shop.Pay.charge', ours: true }]);
  });
});

const incident = { title: 't', errorType: 'TypeError', errorMessage: "Cannot read properties of undefined (reading 'total')", frames: [], operation: '', when: '', source: 'sentry' as const };

describe('judging whether a test reproduced it', () => {
  it('accepts a failure with the same error type and words', () => {
    const judged = judgeReproduction(incident, { passed: false, output: "TypeError: Cannot read properties of undefined (reading 'total') at cart.ts:9" });
    assert.equal(judged.verdict, 'reproduced');
    assert.equal(judged.match, 'same type and message');
  });

  it('refuses a test that passes, instead of weakening it until it fails', () => {
    const judged = judgeReproduction(incident, { passed: true, output: '1 passing' });
    assert.equal(judged.verdict, 'passed');
    assert.match(judged.why, /weakening it until it fails would prove nothing/);
  });

  it('refuses a test that fails for its own reason', () => {
    // The dangerous case: red is not proof. A typo in the test is also red.
    const judged = judgeReproduction(incident, { passed: false, output: 'AssertionError: expected 4 to equal 5' });
    assert.equal(judged.verdict, 'failed-differently');
    assert.match(judged.why, /not with the incident's error/);
  });

  it('quotes the error the test reported, not the runner banner above it', () => {
    // A real refusal read "the test reported RUN v5.0.2 C:/Users/..." - a banner, not a finding.
    const output = ['RUN  v5.0.2 C:/work/project', '', ' FAIL  tests/a.test.js', 'AssertionError: expected 35 to be 40'].join(NL);
    const judged = judgeReproduction(incident, { passed: false, output });
    assert.equal(judged.verdict, 'failed-differently');
    assert.match(judged.why, /AssertionError: expected 35 to be 40/);
    assert.doesNotMatch(judged.why, /v5\.0\.2/);
  });

  it('refuses a test that never ran at all', () => {
    for (const output of ["Error: Cannot find module './cart'", "fixture 'db' not found", 'SyntaxError: unexpected token']) {
      assert.equal(judgeReproduction(incident, { passed: false, output }).verdict, 'never-ran', output);
    }
  });

  it('accepts the same error type even when the message reads differently', () => {
    const judged = judgeReproduction(incident, { passed: false, output: 'TypeError: undefined is not an object' });
    assert.equal(judged.verdict, 'reproduced');
    assert.equal(judged.match, 'same type');
  });

  it('accepts a matching message where neither side names a type', () => {
    const untyped = { ...incident, errorType: '', errorMessage: 'payment declined for expired card' };
    const judged = judgeReproduction(untyped, { passed: false, output: 'payment declined: the card is expired' });
    assert.equal(judged.verdict, 'reproduced');
    assert.equal(judged.match, 'same message');
  });

  it('is not fooled into a match by a long stack trace', () => {
    const noisy = `AssertionError: nope${NL}${'    at somewhere in the code with many words about payment and card and expiry'.repeat(20)}`;
    const untyped = { ...incident, errorType: '', errorMessage: 'payment declined for expired card' };
    // The overlap is measured against the incident's own words, not the output's, so twenty lines
    // of stack trace cannot earn a match by sheer length.
    assert.equal(judgeReproduction(untyped, { passed: false, output: noisy }).verdict, 'failed-differently');
  });
});
