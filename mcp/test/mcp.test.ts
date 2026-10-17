// Talks to the MCP server over stdio with the official client, the way an AI assistant does.
// The AI layer is off and nothing reaches the network.
//
// These five tests used to be skipped unless `data/triage.jsonl` happened to exist, which meant
// they ran on one laptop and nowhere else: `data/` is gitignored, only the Playwright reporter
// writes that file, and no workflow ran the suite at all until Phase 61. The MCP server is
// published to the MCP registry on every tag, so its tests were the ones least able to be skipped
// and the ones being skipped. They now build their own dataset in a temporary folder and point the
// server at it with TRIAGE_DATA_DIR - the same switch the drift lab uses - so they run everywhere
// and do not depend on whatever happens to be in the author's data directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROJECT_ROOT } from '../../reporters/store.ts';

const NL = String.fromCharCode(10);
const AT = '2026-10-16T08:00:00.000Z';
const RUN = 'local-mcp-1';
const FAILING = 'orders load successfully';

/**
 * A dataset the assertions below can actually rest on: one failing test with a value mismatch,
 * which the rules diagnose as a real bug with a confidence and a source, plus an earlier run of
 * the same test so the history line has something to say.
 */
function dataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tewip-mcp-'));
  mkdirSync(dir, { recursive: true });
  const record = (runId: string, at: string) => ({
    schemaVersion: 1,
    testId: FAILING,
    file: 'tests/orders.spec.ts',
    status: 'failed',
    errorMessage: 'Error: expect(received).toBe(expected)' + NL + 'Expected: 4' + NL + 'Received: 3',
    errorStack: '    at tests/orders.spec.ts:12:20',
    duration: 4200,
    retry: 0,
    attachments: [],
    runId,
    gitSha: 'abc1234',
    timestamp: at,
  });
  const run = (runId: string, at: string) => ({
    schemaVersion: 1,
    runId,
    gitSha: 'abc1234',
    branch: 'main',
    startedAt: at,
    finishedAt: at,
    status: 'failed',
    attempts: { [FAILING]: 1 },
  });
  const earlier = '2026-10-15T08:00:00.000Z';
  writeFileSync(join(dir, 'triage.jsonl'), [record('local-mcp-0', earlier), record(RUN, AT)].map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');
  writeFileSync(join(dir, 'runs.jsonl'), [run('local-mcp-0', earlier), run(RUN, AT)].map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');
  return dir;
}

describe('MCP server', () => {
  const client = new Client({ name: 'triage-agent-test', version: '1.0.0' });

  before(async () => {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(PROJECT_ROOT, 'mcp', 'server.ts')],
        cwd: PROJECT_ROOT,
        stderr: 'ignore',
        env: { ...process.env, TRIAGE_DATA_DIR: dataset(), OPENAI_API_KEY: '' },
      }),
    );
  });
  after(() => client.close());

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
  };

  it('lists every tool as read-only, except the two that write, and none destructive', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of ['github_ci_report', 'triage_board', 'pr_impact', 'environment_report', 'release_readiness', 'quality_report', 'architecture_report', 'risk_digest', 'explain_failure', 'list_datasets', 'list_failed_runs', 'test_plan']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    // Two tools write, and each says so rather than claiming to be read-only: `test_plan` saves a plan
    // in the project, and `prove_tests_catch_bugs` edits a source file to break it on purpose and puts
    // it back. Both are honest about it, and neither is destructive - the file is restored byte for
    // byte, and a restore that does not verify is treated as an error rather than ignored.
    const writes = ['test_plan', 'prove_tests_catch_bugs'];
    assert.ok(tools.filter((t) => !writes.includes(t.name)).every((t) => t.annotations?.readOnlyHint === true), 'every other tool must be read-only');
    assert.ok(tools.filter((t) => writes.includes(t.name)).every((t) => t.annotations?.readOnlyHint === false), 'a tool that writes must not claim to be read-only');
    assert.ok(tools.every((t) => t.annotations?.destructiveHint === false), 'no tool may be destructive');
  });

  it('refuses to plan for a project path that is not an existing absolute folder', async () => {
    const { text, isError } = await call('test_plan', { feature: 'checkout', project: 'relative/folder' });
    assert.equal(isError, true);
    assert.match(text, /existing absolute path/);
  });

  it('returns the SDET board for the latest failed run, with confidence and source', async () => {
    const { text, isError } = await call('triage_board', { ai: false });
    assert.equal(isError, false);
    // The run id is asserted, not just the shape: without it this test passes off whatever happens
    // to be in the author's data directory, which is exactly how it came to run nowhere else.
    assert.match(text, new RegExp('# Triage board: run ' + RUN));
    assert.match(text, /confidence \d\.\d\d/);
    assert.match(text, /source: rules/);
  });

  it('explains one failing test', async () => {
    const { text } = await call('explain_failure', { test: FAILING, ai: false });
    assert.match(text, new RegExp('# ' + FAILING));
    assert.match(text, /\*\*History:\*\*/);
  });

  it('reports bad input as a tool error instead of crashing', async () => {
    const { isError, text } = await call('triage_board', { run: 'no-such-run', ai: false });
    assert.equal(isError, true);
    assert.match(text, /No failed run matches/);
  });
});
