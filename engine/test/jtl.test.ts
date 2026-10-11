// Phase 39: JMeter, read properly and judged properly.
//
// Two things were wrong and one was missing. Tewip could not read a real .jtl at all - the importer
// handled only the XML form while CSV is JMeter's default and what every real repository has, so
// `importJunit` answered "not an XML document: no root element" on genuine output. And a .jtl is the
// best performance data Tewip has ever been handed: one row per request, which supports a real
// statistical test rather than the range check that k6's six aggregates force.
//
// The CSV shapes below are from NikeshMan16/JmeterPerformance_testing_Project, whose quoted
// failureMessage contains a comma *and a newline* - one logical record over seven physical lines.
// A line split would have made six corrupt rows out of it, which is why the parser is a real one.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { byLabel, looksLikeCsvJtl, overall, readCsv, readJtlSamples } from '../perf/jtl.ts';
import { compareSamples, ENOUGH_SAMPLES, mannWhitney, median } from '../perf/samples.ts';
import { importJunit } from '../import/junit.ts';

const NL = String.fromCharCode(10);
const HEADER = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes';
const row = (ms: number, label: string, ok = true, code = '200', fail = '') =>
  `1747800551510,${ms},${label},${code},OK,Thread Group 1-1,text,${ok},${fail},1772`;

function file(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tewip-jtl-')), 'results.jtl');
  writeFileSync(path, [HEADER, ...lines].join(NL) + NL, 'utf8');
  return path;
}

describe('reading the CSV JMeter writes by default', () => {
  it('a quoted field may contain a comma', () => {
    const rows = readCsv(`a,b,c${NL}1,"has, a comma",3`);
    assert.deepEqual(rows[1], ['1', 'has, a comma', '3']);
  });

  it('a quoted field may contain a newline, which is the one that matters', () => {
    // The real record: a 400's failureMessage wrapped onto a second line. Splitting on newlines
    // turns one record into two corrupt ones, and the second has no timings in it at all.
    const rows = readCsv(`a,b,c${NL}1,"Test failed: code expected${NL}to equal 200",3${NL}4,ok,6`);
    assert.equal(rows.length, 3);
    assert.equal(rows[1][1], `Test failed: code expected${NL}to equal 200`);
    assert.deepEqual(rows[2], ['4', 'ok', '6']);
  });

  it('a doubled quote inside a quoted field is one quote', () => {
    assert.deepEqual(readCsv(`a${NL}"say ""hi"""`)[1], ['say "hi"']);
  });

  it('recognises a results file by its header, not its extension', () => {
    assert.equal(looksLikeCsvJtl(HEADER), true);
    assert.equal(looksLikeCsvJtl('<?xml version="1.0"?><testResults/>'), false);
    assert.equal(looksLikeCsvJtl('name,value' + NL + 'a,1'), false);
  });

  it('reads the samples, grouped by what was being requested', () => {
    const path = file([row(100, 'Login'), row(120, 'Login'), row(50, 'Search'), row(2000, 'Search', false, '400')]);
    const samples = readJtlSamples(path);
    assert.equal(samples.length, 4);
    const groups = byLabel(samples);
    assert.deepEqual(groups.map((g) => g.label), ['Login', 'Search']);
    assert.deepEqual(groups[1].elapsed, [50, 2000]);
    assert.equal(groups[1].failed, 1);
    assert.deepEqual(groups[1].codes, [{ code: '400', times: 1 }]);
    assert.equal(overall(samples).total, 4);
  });

  it('a truncated row is skipped rather than read as a zero', () => {
    // A run killed mid-flush leaves a short line. A zero in a latency distribution is the one
    // invented value that does real damage.
    const path = join(mkdtempSync(join(tmpdir(), 'tewip-jtl-')), 'x.jtl');
    writeFileSync(path, [HEADER, row(100, 'Login'), '1747800551510,80'].join(NL), 'utf8');
    const samples = readJtlSamples(path);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].elapsed, 100);
  });

  it('refuses a file that is not a results file rather than reporting an empty run', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tewip-jtl-')), 'x.jtl');
    writeFileSync(path, 'nothing,useful' + NL + '1,2', 'utf8');
    assert.throws(() => readJtlSamples(path), /not a CSV JMeter results file/);
  });

  it('the importer reads it too, which it never could', () => {
    const path = file([row(100, 'Login'), row(2000, 'Checkout', false, '500'), row(90, 'Checkout', false, '200')]);
    const { records, summary } = importJunit(path, { runId: 'r', gitSha: 's' });
    assert.equal(summary.status, 'failed');
    const checkout = records.find((r) => r.testId.includes('Checkout'));
    assert.ok(checkout, 'the failing label should be a record');
    // A 2xx that counts as failed is an assertion, and saying "mostly 200" would read as nonsense.
    assert.match(checkout.errorMessage, /2 of 2 requests failed/);
  });
});

describe('comparing two runs request by request', () => {
  const rnd = (n: number, base: number, spread: number, seed = 1) => {
    // A fixed sequence, so a test that passes keeps passing.
    let s = seed;
    return Array.from({ length: n }, () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return base + (s / 2147483648) * spread;
    });
  };

  it('the U statistic matches a brute-force count of the pairs', () => {
    const a = [5, 7, 9, 11];
    const b = [6, 8, 10];
    let u = 0;
    for (const x of a) for (const y of b) u += x > y ? 1 : x === y ? 0.5 : 0;
    assert.equal(mannWhitney(a, b)?.u, u);
  });

  it('ties are shared, which matters because response times are whole milliseconds', () => {
    const tied = mannWhitney([5, 5, 5, 5], [5, 5, 5, 5]);
    assert.ok(tied);
    // Completely tied: no shift at all, and the corrected variance must not invent one.
    assert.equal(tied.u, 8);
    assert.ok(tied.p > 0.9, `identical samples should not be significant, got p=${tied.p}`);
  });

  it(`will not run the test below ${ENOUGH_SAMPLES} requests on either side`, () => {
    const verdict = compareSamples(rnd(10, 500, 50), rnd(200, 100, 50));
    assert.equal(verdict.direction, 'cannot-say');
    assert.equal(verdict.p, null);
    assert.match(verdict.why, /not reliable|Lengthen the run/);
  });

  it('calls a real, large shift what it is', () => {
    const verdict = compareSamples(rnd(200, 300, 40, 7), rnd(200, 100, 40, 3));
    assert.equal(verdict.direction, 'slower');
    assert.ok(verdict.p !== null && verdict.p < 0.01);
    assert.ok(verdict.slowerThanBefore > 0.9, 'a clean separation should be near-certain per request');
    assert.match(verdict.why, /median moved/);
  });

  it('and a real improvement', () => {
    assert.equal(compareSamples(rnd(200, 100, 40, 7), rnd(200, 300, 40, 3)).direction, 'faster');
  });

  it('refuses a difference that is certain but too small to act on', () => {
    // The whole point. With enough samples a fraction of a millisecond is statistically certain,
    // and a tool that reports it has taught its team that regressions are noise.
    const verdict = compareSamples(rnd(4000, 100.4, 20, 11), rnd(4000, 100, 20, 5));
    assert.equal(verdict.direction, 'cannot-say');
    assert.match(verdict.why, /too small to act on|within what these two runs/);
  });

  it('the median is the median, including for an even count', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), 0);
  });
});
