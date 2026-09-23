// Imports test reports from any language or framework into the agent's records: JUnit XML, which
// pytest, Jest, Vitest, Mocha, node:test, Maven Surefire, Gradle, gotestsum, PHPUnit, RSpec,
// cargo-nextest and Cypress write; .NET's own TRX; NUnit 3's result file; Robot Framework's
// output.xml; JMeter's .jtl; and a k6 summary, where a run fails by crossing a threshold rather
// than test by test. Playwright keeps its own importer
// (blob.ts), which also reads traces.
//
// What these reports can and cannot say: each test's name, outcome, failure message and stack,
// and duration; retries when the runner records them. They carry no page snapshot or trace, so
// selector drift is not diagnosed from them. Every format below was checked against a report its
// real runner wrote (fixtures/polyglot, run by .github/workflows/polyglot-fixtures.yml).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, type RunSummary, type TriageRecord } from '../../reporters/types.ts';
import type { ImportMeta, ImportResult } from './blob.ts';
import { descendants, parseXml, type XmlElement } from './xml.ts';
import { jmeterCases, k6Cases, looksLikeK6, robotCases, robotTime } from './other-formats.ts';

interface Attempt {
  failed: boolean;
  message: string;
  stack: string;
}

interface Case {
  testId: string;
  file: string;
  duration: number;
  attempts: Attempt[];
}

const PASSED: Attempt = { failed: false, message: '', stack: '' };
const FAILURE = new Set(['failure', 'error']);
/** Maven Surefire's records of earlier attempts: flaky* when a later one passed, rerun* when not. */
const RETRY_FAILURE = new Set(['flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);

/** A failure's message and detail; runners disagree on which of the two holds what. */
function failure(rawMessage: string, rawDetail: string): Attempt {
  // Terminal colour codes: XML cannot hold the escape character, so runners often write what is left
  // of them ("[2mexpect([22m"); both forms are noise to the rules.
  const plain = (s: string) => s.replace(/\u001b?\[(?:\d{1,3};)*\d{1,3}m/g, '');
  const message = plain(rawMessage);
  const detail = plain(rawDetail);
  const head = message.trim() || detail.split('\n').find((l) => l.trim() !== '') || 'failed';
  const stack = detail.trim();
  // The full detail goes into the message too: outside Playwright the useful part (the assertion,
  // the exception) is usually in the detail, and the rules read the message.
  return { failed: true, message: stack && !stack.includes(head) ? `${head}\n${stack}` : stack || head, stack };
}

const fromElement = (e: XmlElement) =>
  failure(e.attrs.message ?? e.attrs.type ?? '', e.children.find((c) => c.name === 'stackTrace')?.text ?? e.text);

/** The attempts one <testcase> records: earlier failed retries first, then the final outcome. */
function attemptsOf(testcase: XmlElement): Attempt[] {
  const retries = testcase.children.filter((c) => RETRY_FAILURE.has(c.name)).map(fromElement);
  const final = testcase.children.find((c) => FAILURE.has(c.name));
  // No final failure means the last attempt passed: after flakyFailure retries, "failed, then passed".
  return [...retries, final ? fromElement(final) : PASSED];
}

/** A file path relative to the checkout, so the same test has the same id on every machine. */
function relativeFile(file: string, workspace: string | undefined): string {
  const f = file.trim().replaceAll('\\', '/');
  const ws = workspace?.replaceAll('\\', '/').replace(/\/?$/, '/');
  if (ws && f.toLowerCase().startsWith(ws.toLowerCase())) return f.slice(ws.length);
  return f;
}

/**
 * Does this report come from a run that re-ran tests? Either the runner said so with a rerun
 * element, or some test in it is written twice with a failure recorded - both of which pytest's
 * rerun plugin does and an ordinary passing run never does.
 */
function looksLikeReruns(root: XmlElement): boolean {
  let rerunElements = false;
  let failureSeen = false;
  const names = new Set<string>();
  let duplicateWithFailure = false;
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === 'testcase') {
        const key = `${child.attrs.classname ?? ''}::${child.attrs.name ?? ''}`;
        const failed = child.children.some((c) => FAILURE.has(c.name));
        if (child.children.some((c) => RETRY_FAILURE.has(c.name))) rerunElements = true;
        if (failed) failureSeen = true;
        if (names.has(key) && failureSeen) duplicateWithFailure = true;
        names.add(key);
      }
      walk(child);
    }
  };
  walk(root);
  return rerunElements || duplicateWithFailure;
}

function junitCases(root: XmlElement, workspace: string | undefined): Case[] {
  const rerunning = looksLikeReruns(root);
  const out: Case[] = [];
  const walk = (e: XmlElement, suite: XmlElement | undefined) => {
    for (const c of e.children) {
      if (c.name === 'testcase') add(c, suite);
      else walk(c, c.name === 'testsuite' ? c : suite);
    }
  };
  const add = (testcase: XmlElement, suite: XmlElement | undefined) => {
    if (testcase.children.some((c) => c.name === 'skipped')) return;
    const file = relativeFile(testcase.attrs.file ?? suite?.attrs.file ?? '', workspace);
    const parts = [file, testcase.attrs.classname, testcase.attrs.name].map((p) => (p ?? '').trim()).filter(Boolean);
    if (parts.length === 1 && suite?.attrs.name) parts.unshift(suite.attrs.name.trim());
    const testId = [...new Set(parts)].join(' > ');
    const seconds = Number(testcase.attrs.time);
    const attempts = attemptsOf(testcase);
    const previous = out.at(-1);
    if (previous?.testId === testId) {
      // Rerun plugins (pytest-rerunfailures and others) write every attempt as its own entry and
      // only re-run after a failure, so an earlier entry of the same test can be a failed attempt
      // whose error the plugin left out. Only adjacent entries are merged.
      //
      // The inference is only safe where the report shows this runner re-runs tests at all. Without
      // that condition two adjacent entries of the same name were enough to invent a failure, and
      // real suites produce those innocently: node:test repeats a name for a subtest and its
      // parent, so piscina's own 152 passing tests came back as two failing ones, diagnosed as
      // flaky. A test that passed must never be reported as having failed.
      const earlier = previous.attempts.at(-1)!;
      if (!earlier.failed && rerunning) previous.attempts[previous.attempts.length - 1] = { failed: true, message: '', stack: '' };
      previous.attempts.push(...attempts);
      return;
    }
    out.push({ testId, file: file || (testcase.attrs.classname ?? '').trim(), duration: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0, attempts });
  };
  // <testrun> is the root Eclipse's JUnit runner and Ant write; everything inside it is ordinary
  // JUnit XML. A real report in that shape was rejected outright as "no test report Tewip can
  // read", which is a poor answer to a file holding 36 perfectly readable results.
  walk(root, root.name === 'testsuite' ? root : undefined);

  // Attempts whose error the runner did not record borrow the final one's, when there is one.
  for (const c of out) {
    const known = [...c.attempts].reverse().find((a) => a.failed && a.message);
    for (const [i, a] of c.attempts.entries()) {
      if (a.failed && !a.message) c.attempts[i] = known ?? failure('failed and was re-run; the runner did not record this attempt\'s error', '');
    }
  }
  return out;
}

/** "00:00:01.2340000" -> 1234 ms. */
const trxDuration = (d: string | undefined) => {
  const m = d?.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  return m ? Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) : 0;
};

/** .NET's native TRX report (dotnet test --logger trx). */
function trxCases(root: XmlElement): Case[] {
  const methods = new Map<string, { className: string; name: string }>();
  for (const unit of descendants(root, 'UnitTest')) {
    const method = unit.children.find((c) => c.name === 'TestMethod');
    if (unit.attrs.id && method) methods.set(unit.attrs.id, { className: method.attrs.className ?? '', name: method.attrs.name ?? '' });
  }
  return descendants(root, 'UnitTestResult')
    .filter((r) => r.attrs.outcome !== 'NotExecuted')
    .map((r) => {
      const method = methods.get(r.attrs.testId ?? '');
      const testId = method?.className ? `${method.className} > ${method.name}` : (r.attrs.testName ?? '').trim();
      const info = descendants(r, 'ErrorInfo')[0];
      const text = (name: string) => info?.children.find((c) => c.name === name)?.text ?? '';
      const failed = r.attrs.outcome === 'Failed' || r.attrs.outcome === 'Error' || r.attrs.outcome === 'Timeout';
      return {
        testId,
        file: method?.className ?? testId,
        duration: trxDuration(r.attrs.duration),
        attempts: [failed ? failure(text('Message'), text('StackTrace')) : PASSED],
      };
    });
}

/**
 * NUnit 3's own result file (`nunit3-console --result=x.xml`), whose root is <test-run>. NUnit does
 * not write JUnit XML at all - its console offers only the nunit3 and nunit2 formats - so a .NET
 * team on NUnit has nothing else to hand Tewip.
 */
function nunitCases(root: XmlElement): Case[] {
  return descendants(root, 'test-case')
    .filter((t) => t.attrs.result !== 'Skipped' && t.attrs.result !== 'Inconclusive')
    .map((t) => {
      const failureEl = t.children.find((c) => c.name === 'failure');
      const child = (parent: XmlElement | undefined, name: string) => parent?.children.find((c) => c.name === name)?.text ?? '';
      const testId = (t.attrs.fullname ?? '').trim() || [t.attrs.classname, t.attrs.methodname ?? t.attrs.name].filter(Boolean).join(' > ');
      const seconds = Number(t.attrs.duration);
      return {
        testId,
        file: (t.attrs.classname ?? '').trim(),
        duration: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
        attempts: [t.attrs.result === 'Failed' ? failure(child(failureEl, 'message'), child(failureEl, 'stack-trace')) : PASSED],
      };
    });
}

// .jtl is JMeter's, and a k6 summary is JSON; both are read below.
const REPORT_FILE = /\.(xml|trx|jtl|json)$/i;

/** Report files under `path` (a file, or a directory searched recursively). */
export function junitFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && REPORT_FILE.test(d.name))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

/**
 * Imports one or more reports as a single run. Only failed attempts become records, as with
 * Playwright; every test, passing or failing, is counted in the run summary so its history
 * shows the passes too.
 */
/**
 * A runner's own timestamp, when it is one a machine can read.
 *
 * Maven Surefire writes `timestamp="2025-03-05T11:53:11 IST"` - a timezone abbreviation with no
 * offset, which is not a date any parser accepts. `new Date(...).toISOString()` then threw, and
 * Tewip died on one of the most widely used test runners there is. This was found by reading real
 * Surefire reports from public repositories; every fixture collected for this project had a clean
 * timestamp. A report Tewip cannot date is still a report worth reading, so an unreadable one falls
 * back to the time of import rather than stopping everything.
 */
function readTimestamp(raw: string): string | null {
  if (!raw) return null;
  const asIs = new Date(raw);
  if (!Number.isNaN(asIs.getTime())) return asIs.toISOString();
  // Drop a trailing zone abbreviation (IST, CEST, PDT...) and read the rest as local time.
  const withoutZone = new Date(raw.replace(/\s+[A-Z]{2,5}$/, ''));
  return Number.isNaN(withoutZone.getTime()) ? null : withoutZone.toISOString();
}

export function importJunit(path: string, meta: ImportMeta): ImportResult {
  const records: TriageRecord[] = [];
  const attempts: Record<string, number> = {};
  const now = new Date().toISOString();
  let startedAt = '';
  let anyFailed = false;
  const unread: string[] = [];
  let parsedFiles = 0;

  for (const file of junitFiles(path)) {
    const raw = readFileSync(file, 'utf8');
    // k6 writes JSON, not XML: a performance run fails by crossing a threshold, not test by test.
    if (/\.json$/i.test(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        unread.push(`${file} (not JSON)`);
        continue;
      }
      if (!looksLikeK6(parsed)) {
        unread.push(`${file} (JSON, but not a k6 summary)`);
        continue;
      }
      parsedFiles++;
      addCases(k6Cases(parsed));
      continue;
    }
    const root = parseXml(raw);
    let cases: Case[];
    if (root.name === 'TestRun') {
      cases = trxCases(root);
      const start = descendants(root, 'Times')[0]?.attrs.start;
      if (start && (!startedAt || start < startedAt)) startedAt = start;
    } else if (root.name === 'testsuites' || root.name === 'testsuite' || root.name === 'testrun') {
      cases = junitCases(root, meta.workspace);
      const stamp = root.attrs.timestamp ?? root.children.find((c) => c.name === 'testsuite')?.attrs.timestamp;
      if (stamp && (!startedAt || stamp < startedAt)) startedAt = stamp;
    } else if (root.name === 'test-run') {
      cases = nunitCases(root);
      const start = root.attrs['start-time'];
      if (start && (!startedAt || start < startedAt)) startedAt = start;
    } else if (root.name === 'robot') {
      cases = robotCases(root);
      const start = robotTime(root.attrs.generated ?? '');
      if (start && !startedAt) startedAt = start;
    } else if (root.name === 'testResults') {
      cases = jmeterCases(root);
    } else {
      // Not a report Tewip knows. Staying silent here would report a failing run as clean, so the
      // file is remembered and, if nothing at all could be read, the caller is told.
      unread.push(`${file} (root <${root.name}>)`);
      continue;
    }

    parsedFiles++;
    addCases(cases);
  }

  function addCases(cases: Case[]): void {
    for (const c of cases) {
      attempts[c.testId] = (attempts[c.testId] ?? 0) + c.attempts.length;
      c.attempts.forEach((attempt, retry) => {
        if (!attempt.failed) return;
        anyFailed = true;
        records.push({
          schemaVersion: SCHEMA_VERSION,
          testId: c.testId,
          file: c.file,
          status: 'failed',
          errorMessage: attempt.message,
          errorStack: attempt.stack,
          duration: c.duration,
          retry,
          attachments: [],
          runId: meta.runId,
          gitSha: meta.gitSha,
          timestamp: now,
        });
      });
    }
  }

  const summary: RunSummary = {
    schemaVersion: SCHEMA_VERSION,
    runId: meta.runId,
    gitSha: meta.gitSha,
    ...(meta.branch ? { branch: meta.branch } : {}),
    startedAt: readTimestamp(startedAt) ?? now,
    finishedAt: now,
    status: anyFailed ? 'failed' : 'passed',
    attempts,
  };
  // Never let an unreadable report look like a clean run: a run that failed would pass the gate.
  if (unread.length > 0) {
    const list = unread.slice(0, 5).join(', ');
    if (parsedFiles === 0) {
      throw new Error(
        `no test report Tewip can read in ${path}: ${list}. It reads JUnit XML (<testsuites>/<testsuite>/<testrun>), NUnit 3 (<test-run>), .NET TRX (<TestRun>), ` +
          'Robot Framework output.xml (<robot>), JMeter .jtl (<testResults>) and a k6 summary (--summary-export). ' +
          'Most runners can write JUnit XML; for TestNG use the Surefire report, and for NUnit use --result=x.xml.',
      );
    }
    console.error(`[tewip] ignored ${unread.length} file(s) that are not a test report: ${list}`);
  }
  return { records, summary, skippedShards: [] };
}
