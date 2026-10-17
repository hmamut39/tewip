// Phase 16: reading a production incident, and judging whether a test really reproduces it.
//
// The parsing tests use the shapes the tools actually emit. The judgement tests are the important
// ones: a test that fails is not a reproduction, and everything here exists to stop Tewip claiming
// otherwise.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { framesFromStack, ourFrames, readIncident } from '../incident/incident.ts';
import { judgeReproduction } from '../incident/reproduced.ts';
import { importPathFor } from '../incident/incident-command.ts';

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

// Phase 69: field-tested on a real stack trace from this repository - a real TypeError thrown by
// real code, captured from the error object the way a production logger would. Two defects stopped
// the command dead, and both were in the plumbing rather than the idea.
describe('a stack trace as a modern Node actually prints it', () => {
  const REAL = [
    "TypeError: Cannot read properties of undefined (reading 'length')",
    '    at renderAccess (file:///C:/Users/Afiyat/triage-agent/engine/access/render.ts:129:37)',
    '    at file:///C:/Users/Afiyat/scratch/crash.ts:4:1',
    '    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)',
  ].join(String.fromCharCode(10));

  it('reads an ESM frame, which is a file:// URL and has colons in it', () => {
    // The file group was `[^():]+?` - no colons allowed - and a `file://` URL has one in the scheme
    // and a Windows path another in the drive letter. Not one ESM frame could be read, on any
    // platform, in any project with "type": "module". The command's whole premise is writing a test
    // against the code the trace names, and it could not name the code: on this very trace it said
    // "it names no file inside this project" about a file in this project.
    const frames = framesFromStack(REAL);
    assert.equal(frames.length, 3);
    assert.equal(frames[0].file, 'C:/Users/Afiyat/triage-agent/engine/access/render.ts');
    assert.equal(frames[0].line, 129);
    assert.equal(frames[0].fn, 'renderAccess');
    assert.equal(frames[0].ours, true);
  });

  it('reads a POSIX file:// URL as a rooted path', () => {
    const [frame] = framesFromStack('    at pay (file:///app/src/pay.ts:42:9)');
    assert.equal(frame.file, '/app/src/pay.ts');
  });

  it('decodes a path that was escaped into the URL', () => {
    const [frame] = framesFromStack('    at go (file:///app/my%20code/pay.ts:7:1)');
    assert.equal(frame.file, '/app/my code/pay.ts');
  });

  it('still keeps the runtime out of "ours"', () => {
    assert.equal(framesFromStack(REAL).at(-1)?.ours, false, 'node:internal is not the team\'s code');
  });

  it('did not lose the formats that already worked', () => {
    const others = [
      '    at handler (/app/src/pay.ts:42:9)',
      '  File "/app/pay.py", line 42, in charge',
      '    at com.shop.Pay.charge(Pay.java:42)',
    ].join(String.fromCharCode(10));
    assert.deepEqual(
      framesFromStack(others).map((f) => `${f.file}:${f.line}`),
      ['/app/src/pay.ts:42', '/app/pay.py:42', 'Pay.java:42'],
    );
  });
});

describe('how the written test imports the code it is about', () => {
  it('is relative to the folder the test will be written in', () => {
    // The model was given project-relative paths and nothing else, so a test written into
    // engine/test/ imported '../engine/access/render.ts' - which resolves to
    // engine/engine/access/render.ts, does not exist, and made `incident` report
    // "the test never ran - something was missing or would not compile" about a correct test.
    assert.equal(importPathFor('/p', '/p/engine/test', 'engine/access/render.ts'), '../access/render.ts');
  });

  it('keeps a leading ./ so Node reads it as a path, not a package', () => {
    assert.equal(importPathFor('/p', '/p', 'src/pay.ts'), './src/pay.ts');
  });
});
