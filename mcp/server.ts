#!/usr/bin/env node
// MCP server for Tewip: lets any MCP-capable AI assistant (Claude Code, Claude Desktop,
// Cursor, VS Code agent mode, ...) ask about Playwright test failures and get the same
// diagnoses, next actions and role views the agent produces in CI.
// Read-only by design, except test_plan, which saves the plan it returns in the project's .tewip
// folder: no tool changes code, CI, GitHub or collected data.
// Run: node mcp/server.ts (stdio). Setup for each client is in README.md.
import { registerProofTools } from './tools-prove.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { githubCiReport } from './github-report.ts';
import { explainFailure, listDatasets, listFailedRuns, runView, windowView } from './tools.ts';

/**
 * The version a client is told, read from the package rather than written here. It had drifted to 0.5.0
 * while the package was at 0.32.0 - a small lie, but this server's whole job is to be the thing that
 * does not say unverified numbers.
 */
const version = ((): string => {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const server = new McpServer({ name: 'tewip', version });

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const dataset = z.string().optional().describe('Dataset directory relative to the Tewip repo, e.g. "data/real/gutenberg-holdout". Default: data/ (what the reporter collected). See list_datasets.');
const run = z.string().optional().describe('Run id or a unique part of it. Default: the latest run with failures.');
const ai = z.boolean().optional().describe('Use the AI layer for failures the rules cannot decide (default true; needs OPENAI_API_KEY).');

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
async function answer(fn: () => string | Promise<string>): Promise<Result> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Tewip: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

server.registerTool(
  'github_ci_report',
  {
    title: 'CI diagnosis for a pull request',
    description: "Latest Tewip report from a GitHub repository's CI: which failing tests the change likely caused, why each failed, the next action, and any verified fix PR. Use for questions like \"why did CI fail on my PR?\".",
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

server.registerTool(
  'test_plan',
  {
    title: 'Write a test plan for a feature',
    description:
      'A test plan grounded in a project on this machine: its existing tests (read in full where related), the code the feature lives in, an optional git change and live pages, and the failures Tewip diagnosed there before. Returns risks, prioritised scenarios, what is already covered and what to automate next. Saves the plan in the project\'s .tewip/plans (nothing else is written). Needs OPENAI_API_KEY; takes about a minute.',
    inputSchema: {
      feature: z.string().describe('What the feature does, in a sentence or two'),
      project: z.string().describe('Absolute path of the project folder'),
      diff: z.string().optional().describe('A git range whose change to plan for, e.g. "main...HEAD"'),
      urls: z.array(z.string()).optional().describe('Pages of the running app to read, e.g. ["http://localhost:3000/checkout"]'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ feature, project, diff, urls }) =>
    answer(async () => {
      if (!isAbsolute(project) || !existsSync(project)) throw new Error(`project must be an existing absolute path, got "${project}"`);
      const { planProject } = await import('../engine/quality/plan-command.ts');
      const { markdown, out } = await planProject({ feature, root: project, diffRange: diff, urls: urls ?? [] });
      return `${markdown}\n\n(Saved to ${out}. To turn it into verified tests, run \`tewip write\` in that folder.)`;
    }),
);

/**
 * The project's own memory, its thread from requirement to run, and its evidence bundle. All three
 * read what Tewip already kept for a project on this machine, call no model, and change nothing -
 * which is what makes them safe to hand an assistant that may call them on its own.
 */
const project = z.string().describe('Absolute path of the project folder');

server.registerTool(
  'recall',
  {
    title: 'Has this happened here before?',
    description:
      "What this project already concluded about a failure like this one: earlier failures that resemble it, what was decided, by which rule or which person, and the run each came from. Answers from records Tewip kept, never from a guess - and says plainly when nothing resembles it. Use before deciding what a failure means, and for questions like \"have we seen this error before?\".",
    inputSchema: {
      question: z.string().describe('An error message, or a question in plain words'),
      project,
      test: z.string().optional().describe('Narrow to one test id, when the question is about a particular test'),
    },
    annotations: readOnly,
  },
  ({ question, project: root, test }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      const { recallReport } = await import('../engine/recall/recall-command.ts');
      return recallReport({ root, question, testId: test }).report;
    }),
);

server.registerTool(
  'trace_requirements',
  {
    title: 'Is this requirement covered, and is it passing?',
    description:
      'Joins the plans Tewip wrote for a project to the tests that cover them and the runs that attempted them. A scenario counts as covered only when a real test can be named, and as passing only when a real run attempted it; everything else is reported as never run or not covered. Use for "are we ready to release?" and "what is not tested?".',
    inputSchema: { project, only: z.string().optional().describe('Only plans whose title, ticket or feature contains this') },
    annotations: readOnly,
  },
  ({ project: root, only }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      const { traceReport } = await import('../engine/trace/trace-command.ts');
      return traceReport({ root, only }).report;
    }),
);

server.registerTool(
  'next_action',
  {
    title: 'What should be done next about a goal?',
    description:
      'Given a goal in plain words - "keep the checkout flow green" - says what Tewip would do next and why, from what it can actually see in the project. The order is fixed and published: a real bug first, then the environment, then flakiness, then anything failing it cannot explain, then a coverage gap. It decides only; it never changes a file.',
    inputSchema: { goal: z.string().describe('The goal, in plain words'), project },
    annotations: readOnly,
  },
  ({ goal, project: root }) =>
    answer(async () => {
      if (!isAbsolute(root) || !existsSync(root)) throw new Error(`project must be an existing absolute path, got "${root}"`);
      // observe/decide/render are pure; runPursue prints, which would corrupt the protocol.
      const { observe, renderPursuit } = await import('../engine/pursue/pursue-command.ts');
      const { decide } = await import('../engine/pursue/policy.ts');
      const observed = observe(root, goal);
      return renderPursuit(goal, observed, decide(goal, observed), false);
    }),
);

registerProofTools(server, { answer, readOnly, project });

await server.connect(new StdioServerTransport());
