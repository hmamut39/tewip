#!/usr/bin/env node
// MCP server for triage-agent: lets any MCP-capable AI assistant (Claude Code, Claude Desktop,
// Cursor, VS Code agent mode, ...) ask about Playwright test failures and get the same
// diagnoses, next actions and role views the agent produces in CI.
// Read-only by design: no tool changes code, CI, GitHub or collected data.
// Run: node mcp/server.ts (stdio). Setup for each client is in README.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { githubCiReport } from './github-report.ts';
import { explainFailure, listDatasets, listFailedRuns, runView, windowView } from './tools.ts';

const server = new McpServer({ name: 'triage-agent', version: '0.3.0' });

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const dataset = z.string().optional().describe('Dataset directory relative to the triage-agent repo, e.g. "data/real/gutenberg-holdout". Default: data/ (what the reporter collected). See list_datasets.');
const run = z.string().optional().describe('Run id or a unique part of it. Default: the latest run with failures.');
const ai = z.boolean().optional().describe('Use the AI layer for failures the rules cannot decide (default true; needs OPENAI_API_KEY).');

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
async function answer(fn: () => string | Promise<string>): Promise<Result> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `triage-agent: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

server.registerTool(
  'github_ci_report',
  {
    title: 'CI diagnosis for a pull request',
    description: "Latest triage-agent report from a GitHub repository's CI: which failing tests the change likely caused, why each failed, the next action, and any verified fix PR. Use for questions like \"why did CI fail on my PR?\".",
    inputSchema: {
      repo: z.string().describe('owner/name, e.g. hmamut39/triage-agent-sandbox'),
      pr: z.number().int().optional().describe('Pull request number'),
      branch: z.string().optional().describe('Branch name, when there is no PR'),
    },
    annotations: { ...readOnly, openWorldHint: true },
  },
  ({ repo, pr, branch }) => answer(() => githubCiReport(repo, pr, branch)),
);

server.registerTool(
  'list_datasets',
  { title: 'List datasets', description: 'Collected failure datasets on this machine, with size and latest run.', inputSchema: {}, annotations: readOnly },
  () => answer(listDatasets),
);

server.registerTool(
  'list_failed_runs',
  { title: 'List failed runs', description: 'Latest runs with failing tests: run id, time, branch and number of failing tests.', inputSchema: { dataset, limit: z.number().int().min(1).max(100).optional() }, annotations: readOnly },
  ({ dataset: d, limit }) => answer(() => listFailedRuns(d, limit)),
);

const runViews = [
  ['triage_board', 'sdet', 'SDET triage board', 'Every failing test of a run, grouped by next action (fix locator, stabilize, fix data, file bug, re-run environment, escalate), with confidence and evidence.'],
  ['pr_impact', 'developer', 'Is this failure caused by the change?', 'Developer view of a run: which failures the change likely caused and which it probably did not, with the reason.'],
  ['environment_report', 'environment', 'Environment failures', 'DevOps / SRE view of a run: environment failures grouped by the failing dependency, retry recovery, and one grouped alert text.'],
  ['release_readiness', 'release', 'Release readiness', 'Business / UAT view of a run in plain words: READY, WAIT or NOT READY, and which product areas are broken.'],
] as const;
for (const [name, view, title, description] of runViews) {
  server.registerTool(name, { title, description, inputSchema: { dataset, run, ai }, annotations: readOnly }, ({ dataset: d, run: r, ai: a }) =>
    answer(() => runView(view, d, r, a ?? true)),
  );
}

const windowViews = [
  ['quality_report', 'quality', 'Engineering quality', 'Senior / principal engineer view over the whole dataset: flakiness hotspots, recurring root-cause patterns, test-design debt ranked by CI time lost.'],
  ['architecture_report', 'architecture', 'Architecture fragility', 'Architect view: fragile areas (main-branch bugs vs regressions caught in PRs), single commits that broke many suites, failing service dependencies.'],
  ['risk_digest', 'digest', 'Risk digest', 'Lead / manager view: product areas whose failure rate grew between the first and second half of the data window, on the main branch.'],
] as const;
for (const [name, view, title, description] of windowViews) {
  server.registerTool(name, { title, description, inputSchema: { dataset, ai }, annotations: readOnly }, ({ dataset: d, ai: a }) => answer(() => windowView(view, d, a ?? true)));
}

server.registerTool(
  'explain_failure',
  {
    title: 'Explain one failing test',
    description: 'Everything the agent knows about one failing test: root cause, confidence and source, full evidence, history on this commit versus others, the next action and why.',
    inputSchema: { test: z.string().describe('Part of the test name or file, case-insensitive'), dataset, run, ai },
    annotations: readOnly,
  },
  ({ test, dataset: d, run: r, ai: a }) => answer(() => explainFailure(test, d, r, a ?? true)),
);

await server.connect(new StdioServerTransport());
