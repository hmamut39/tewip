// Imports test reports from any language or framework into the agent's records: JUnit XML, which
// pytest, Jest, Vitest, Mocha, node:test, Maven Surefire, Gradle, gotestsum, PHPUnit, RSpec,
// cargo-nextest and Cypress write, and .NET's own TRX. Playwright keeps its own importer
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
  const plain = (s: string) => s.replace(/?\[(?:\d{1,3};)*\d{1,3}m/g, '');
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

function junitCases(root: XmlElement, workspace: string | undefined): Case[] {
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
      // only re-run after a failure, so an earlier entry of the same test is a failed attempt even
      // when the plugin left its error out. Only adjacent entries are merged.
      const earlier = previous.attempts.at(-1)!;
      if (!earlier.failed) previous.attempts[previous.attempts.length - 1] = { failed: true, message: '', stack: '' };
      previous.attempts.push(...attempts);
      return;
    }
    out.push({ testId, file: file || (testcase.attrs.classname ?? '').trim(), duration: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0, attempts });
  };
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

const REPORT_FILE = /\.(xml|trx)$/i;

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
export function importJunit(path: string, meta: ImportMeta): ImportResult {
  const records: TriageRecord[] = [];
  const attempts: Record<string, number> = {};
  const now = new Date().toISOString();
  let startedAt = '';
  let anyFailed = false;

  for (const file of junitFiles(path)) {
    const root = parseXml(readFileSync(file, 'utf8'));
    let cases: Case[];
    if (root.name === 'TestRun') {
      cases = trxCases(root);
      const start = descendants(root, 'Times')[0]?.attrs.start;
      if (start && (!startedAt || start < startedAt)) startedAt = start;
    } else if (root.name === 'testsuites' || root.name === 'testsuite') {
      cases = junitCases(root, meta.workspace);
      const stamp = root.attrs.timestamp ?? root.children.find((c) => c.name === 'testsuite')?.attrs.timestamp;
      if (stamp && (!startedAt || stamp < startedAt)) startedAt = stamp;
    } else {
      continue; // some other XML file in the same directory
    }

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
    startedAt: startedAt ? new Date(startedAt).toISOString() : now,
    finishedAt: now,
    status: anyFailed ? 'failed' : 'passed',
    attempts,
  };
  return { records, summary, skippedShards: [] };
}
