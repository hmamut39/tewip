// Talks to the MCP server over stdio with the official client, the way an AI assistant does.
// Uses the local synthetic data in data/ with the AI layer off; no network.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROJECT_ROOT } from '../../reporters/store.ts';

const hasLocalData = existsSync(join(PROJECT_ROOT, 'data', 'triage.jsonl'));

describe('MCP server', { skip: hasLocalData ? false : 'no local data/triage.jsonl (run npm test once)' }, () => {
  const client = new Client({ name: 'triage-agent-test', version: '1.0.0' });

  before(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(PROJECT_ROOT, 'mcp', 'server.ts')], cwd: PROJECT_ROOT, stderr: 'ignore' }));
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
    assert.match(text, /# Triage board: run /);
    assert.match(text, /confidence \d\.\d\d/);
    assert.match(text, /source: rules/);
  });

  it('explains one failing test', async () => {
    const { text } = await call('explain_failure', { test: 'orders load successfully', ai: false });
    assert.match(text, /# orders load successfully/);
    assert.match(text, /\*\*History:\*\*/);
  });

  it('reports bad input as a tool error instead of crashing', async () => {
    const { isError, text } = await call('triage_board', { run: 'no-such-run', ai: false });
    assert.equal(isError, true);
    assert.match(text, /No failed run matches/);
  });
});
