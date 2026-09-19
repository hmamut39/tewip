// Imports a JUnit XML report into the agent's records, so any language or framework that can
// write one gets root-cause triage: pytest (--junitxml), Jest/Vitest (jest-junit, the junit
// reporter), Maven Surefire and Gradle, Go (go-junit-report), .NET (JunitXml.TestLogger), Cypress
// and Selenium runners. Playwright keeps its own importer (blob.ts), which also reads traces.
//
// What a JUnit report can and cannot say: it names each test, its outcome, the failure message
// and stack, and its duration. Surefire additionally records retries (flakyFailure when a later
// attempt passed, rerunFailure when it did not), which the agent's retry rule relies on. It has
// no page snapshot or trace, so selector drift is not diagnosed from it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, type RunSummary, type TriageRecord } from '../../reporters/types.ts';
import type { ImportMeta, ImportResult } from './blob.ts';
import { parseXml, type XmlElement } from './xml.ts';

interface Attempt {
  failed: boolean;
  message: string;
  stack: string;
}

const FAILURE = new Set(['failure', 'error']);
const RETRY_FAILURE = new Set(['flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);

/** A failure element's message and text; JUnit writers disagree on which one holds what. */
function describeFailure(e: XmlElement): Attempt {
  const text = e.text.trim();
  const stackTrace = e.children.find((c) => c.name === 'stackTrace')?.text.trim() ?? '';
  const message = (e.attrs.message ?? '').trim();
  const type = (e.attrs.type ?? '').trim();
  const stack = stackTrace || text;
  const head = message || stack.split('\n').find((l) => l.trim() !== '') || type || e.name;
  // Keep the full detail in the message too: the rules read error text, and for most
  // non-Playwright frameworks the useful part (the assertion, the exception) is in the stack.
  return { failed: true, message: stack && !stack.includes(head) ? `${head}\n${stack}` : stack || head, stack };
}

/** The attempts one <testcase> records: earlier failed retries first, then the final outcome. */
function attemptsOf(testcase: XmlElement): Attempt[] {
  const retries = testcase.children.filter((c) => RETRY_FAILURE.has(c.name)).map(describeFailure);
  const final = testcase.children.find((c) => FAILURE.has(c.name));
  // No final failure means the last attempt passed: with flakyFailure retries, that is exactly
  // "failed, then passed on a retry".
  return [...retries, final ? describeFailure(final) : { failed: false, message: '', stack: '' }];
}

/** A stable test id: the suite or file, the class, and the test name, joined like Playwright's. */
function testIdOf(testcase: XmlElement, suite: XmlElement | undefined): string {
  const parts = [testcase.attrs.file ?? suite?.attrs.file, testcase.attrs.classname, testcase.attrs.name].map((p) => (p ?? '').trim()).filter(Boolean);
  if (parts.length === 1 && suite?.attrs.name) parts.unshift(suite.attrs.name.trim());
  return [...new Set(parts)].join(' > ');
}

/** Test cases with the nearest enclosing suite (suites nest in Jest and Mocha reports). */
function testcases(root: XmlElement): Array<{ testcase: XmlElement; suite: XmlElement | undefined }> {
  const out: Array<{ testcase: XmlElement; suite: XmlElement | undefined }> = [];
  const walk = (e: XmlElement, suite: XmlElement | undefined) => {
    for (const c of e.children) {
      if (c.name === 'testcase') out.push({ testcase: c, suite });
      else walk(c, c.name === 'testsuite' ? c : suite);
    }
  };
  walk(root, root.name === 'testsuite' ? root : undefined);
  return out;
}

/** JUnit XML files under `path` (a file, or a directory searched recursively). */
export function junitFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.xml'))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

/**
 * Imports one or more JUnit reports as a single run. Only failed attempts become records, as
 * with Playwright; every test, passing or failing, is counted in the run summary so its history
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
    if (root.name !== 'testsuites' && root.name !== 'testsuite') continue;
    const stamp = root.attrs.timestamp ?? root.children.find((c) => c.name === 'testsuite')?.attrs.timestamp;
    if (stamp && (!startedAt || stamp < startedAt)) startedAt = stamp;

    for (const { testcase, suite } of testcases(root)) {
      if (testcase.children.some((c) => c.name === 'skipped')) continue;
      const testId = testIdOf(testcase, suite);
      const tries = attemptsOf(testcase);
      attempts[testId] = (attempts[testId] ?? 0) + tries.length;
      const seconds = Number(testcase.attrs.time);
      const duration = Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
      tries.forEach((attempt, retry) => {
        if (!attempt.failed) return;
        anyFailed = true;
        records.push({
          schemaVersion: SCHEMA_VERSION,
          testId,
          file: (testcase.attrs.file ?? suite?.attrs.file ?? testcase.attrs.classname ?? '').trim(),
          status: 'failed',
          errorMessage: attempt.message,
          errorStack: attempt.stack,
          duration,
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
