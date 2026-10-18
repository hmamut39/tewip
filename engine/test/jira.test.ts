// Phase 10: the work item loop. Filing into someone's backlog is the easiest place to do damage, so
// these tests are mostly about restraint: create nothing unless asked, never file the same scenario
// twice, and never touch a ticket's workflow.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { jiraFromEnv, plainText } from '../work/jira.ts';
import { issueBody, runJira, TEWIP_LABEL } from '../work/jira-command.ts';

const scenario = (id: string, covered = '') => ({
  id, title: `searches by ${id}`, type: 'functional', priority: 'P1' as const, preconditions: 'the library has books',
  steps: ['open /library', 'type a word', 'press Search'], expected: 'matching passages are listed', automate: true, covered_by: covered, grounded_on: 'the library page',
});
const PLAN = { feature: 'Library search', plan: { title: 'Library search', summary: '', scope: [], out_of_scope: [], risks: [], open_questions: [], scenarios: [scenario('LS-001'), scenario('LS-002'), scenario('LS-003', 'tests/search.spec.ts: finds a word')] } };

function planFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'tewip-jira-')), 'plan.json');
  writeFileSync(file, JSON.stringify(PLAN), 'utf8');
  return file;
}

/** A Jira that records what it was asked to do, and answers like the real one. */
function fakeJira(existing: Array<{ key: string; summary: string }> = []) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { method?: string; body?: string }) => {
    const path = String(url).replace('https://team.atlassian.net', '');
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined });
    const json = path.startsWith('/rest/api/3/issue/createmeta')
      ? { projects: [{ issuetypes: [{ name: 'Task' }, { name: 'Test' }] }] }
      : path.startsWith('/rest/api/3/search')
        ? { issues: existing.map((e) => ({ key: e.key, fields: { summary: e.summary } })) }
        : { key: `PROJ-${100 + calls.filter((c) => c.method === 'POST').length}` };
    return { ok: true, status: 200, json: async () => json, text: async () => '' };
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const ENV = { TEWIP_JIRA_URL: 'https://team.atlassian.net', TEWIP_JIRA_EMAIL: 'me@team.com', TEWIP_JIRA_TOKEN: 'token' };
const saved: Record<string, string | undefined> = {};
function withJiraEnv() {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe('filing a plan as work items', () => {
  it('creates nothing until it is asked to, and says what it would file', async () => {
    withJiraEnv();
    const jira = fakeJira();
    const lines: string[] = [];
    const log = console.log;
    console.log = (l: string) => lines.push(l);
    try {
      await runJira({ planFile: planFile(), projectKey: 'PROJ', create: false, only: [] });
    } finally {
      console.log = log;
      jira.restore();
    }
    assert.equal(jira.calls.filter((c) => c.method === 'POST').length, 0, 'nothing may be created without --create');
    assert.match(lines.join('\n'), /would create: LS-001/);
    assert.match(lines.join('\n'), /Nothing was created/);
  });

  it('files the uncovered scenarios, skips one an earlier run already filed, and labels them', async () => {
    withJiraEnv();
    const jira = fakeJira([{ key: 'PROJ-9', summary: 'LS-001 searches by LS-001' }]);
    const log = console.log;
    const lines: string[] = [];
    console.log = (l: string) => lines.push(l);
    try {
      await runJira({ planFile: planFile(), projectKey: 'PROJ', create: true, only: [] });
    } finally {
      console.log = log;
      jira.restore();
    }
    const created = jira.calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue');
    assert.equal(created.length, 1, 'LS-001 was already filed and LS-003 is covered by a test');
    const fields = (created[0].body as { fields: { summary: string; labels: string[]; issuetype: { name: string } } }).fields;
    assert.match(fields.summary, /^LS-002 /);
    assert.ok(fields.labels.includes(TEWIP_LABEL));
    assert.equal(fields.issuetype.name, 'Test', 'uses a type the project really has');
    assert.match(lines.join('\n'), /already filed as PROJ-9/);
  });

  it('never moves, assigns or closes anything', async () => {
    withJiraEnv();
    const jira = fakeJira();
    const log = console.log;
    console.log = () => {};
    try {
      await runJira({ planFile: planFile(), projectKey: 'PROJ', create: true, only: [] });
    } finally {
      console.log = log;
      jira.restore();
    }
    const forbidden = jira.calls.filter((c) => /transitions|assignee/.test(c.path) || c.method === 'PUT' || c.method === 'DELETE');
    assert.deepEqual(forbidden, [], 'the board belongs to the team');
  });

  it('writes a test case a person can follow, with where it came from', () => {
    const body = issueBody(scenario('LS-002'), 'Library search', 'PROJ-42');
    assert.match(body, /From: PROJ-42/);
    assert.match(body, /1\. open \/library/);
    assert.match(body, /Expected: matching passages are listed/);
    assert.match(body, /Not covered by an existing test\./);
  });
});

describe('reading a ticket', () => {
  it('flattens Atlassian\'s document format into the words', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A reader searches the library.' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'It must be fast.' }] }] };
    assert.equal(plainText(doc).trim(), 'A reader searches the library.\nIt must be fast.');
  });

  it('says Jira is not set up rather than half-working', () => {
    for (const k of Object.keys(ENV)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    assert.equal(jiraFromEnv(), null);
  });
});

// Phase 76: field-tested on a real plan `tewip plan` wrote for a real change.
//
// The export half works: both CSVs parse under a strict parser, with consistent columns and
// multi-line step fields correctly quoted. The dry run did not work at all.
describe('showing what would be filed, with no tracker set up', () => {
  const noJira = () => {
    for (const k of Object.keys(ENV)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  };
  const captured = () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    return { lines, restore: () => void (console.log = original) };
  };

  it('lists the scenarios instead of demanding an account', async () => {
    // This file's own header says "It shows what it would create and creates nothing until asked",
    // and the help text says "Shows what it would create" - but the refusal ran whatever was asked,
    // so somebody who only wanted the list had to go and get a Jira account first. `bugs`, which
    // does this job for failures, has always answered the case.
    noJira();
    const out = captured();
    try {
      await runJira({ planFile: planFile(), projectKey: 'PROJ', create: false, only: [] } as never);
    } finally {
      out.restore();
    }
    const text = out.lines.join(String.fromCharCode(10));
    assert.match(text, /No tracker was contacted: this is what would be filed/);
    assert.match(text, /LS-001 {2}would create/);
    assert.match(text, /LS-002 {2}would create/);
  });

  it('says it could not check what was already filed, rather than implying the list is new work', async () => {
    noJira();
    const out = captured();
    try {
      await runJira({ planFile: planFile(), projectKey: 'PROJ', create: false, only: [] } as never);
    } finally {
      out.restore();
    }
    const text = out.lines.join(String.fromCharCode(10));
    assert.match(text, /could not check which of these you have already filed/);
    assert.match(text, /that answer is in the tracker, not in the plan/);
  });

  it('still refuses to file anything without a tracker', async () => {
    noJira();
    await assert.rejects(() => runJira({ planFile: planFile(), projectKey: 'PROJ', create: true, only: [] } as never), /Jira is not set up/);
  });

  it('honours --only in the dry run too', async () => {
    noJira();
    const out = captured();
    try {
      await runJira({ planFile: planFile(), projectKey: 'PROJ', create: false, only: ['LS-002'] } as never);
    } finally {
      out.restore();
    }
    const text = out.lines.join(String.fromCharCode(10));
    assert.match(text, /LS-002 {2}would create/);
    assert.doesNotMatch(text, /LS-001 {2}would create/);
  });
});
