#!/usr/bin/env node
// Tewip on the command line. One command, a few verbs:
//   tewip explain <report>          why each test in a report failed, and what to do next
//   tewip ci <owner/repo> [--pr N]  the latest Tewip report from a repository's CI
//   tewip plan "<feature>"          a test plan grounded in the project
//   tewip write [--only IDs]        tests for a plan's scenarios, kept only when verified
//   tewip mcp                       serve Tewip to an AI assistant or editor over MCP (stdio)
//   tewip --version | --help
// The verbs reuse the same code as the GitHub Action and the MCP server: one engine, many outlets.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// cli/ in the source tree, dist/cli/ in the published package: package.json is one or two levels up.
const ROOT = [join(import.meta.dirname, '..'), join(import.meta.dirname, '..', '..')].find((d) => existsSync(join(d, 'package.json'))) ?? join(import.meta.dirname, '..');
const version = (): string => (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const HELP = `Tewip - finds why each test failed, for any stack.

Usage:
  tewip explain <report>            Explain a test report: a JUnit XML or .trx file, a folder of
                                    them, or a Playwright blob-report folder. Keeps history per
                                    project, so later runs are judged against earlier ones.
      --name <project>              Keep this project's history apart from others.
  tewip ci <owner/repo> [--pr N | --branch B]
                                    Show the latest report Tewip's GitHub Action uploaded (uses
                                    your gh login). Without --pr or --branch: the newest run.
  tewip plan "<feature>" | --issue PROJ-123 [--diff main...HEAD] [--url <page> ...] [--out plan.md]
                                    Write a test plan grounded in the project: its existing tests,
                                    the change, the live pages and Tewip's failure history.
  tewip write [--plan plan.json] [--only LS-002,LS-003] [--framework playwright] [--runs 3]
                                    Write tests for the plan's scenarios in the project's own
                                    framework (Playwright, Cypress, WebdriverIO, Jest, Vitest,
                                    pytest, JUnit, .NET, Go). Keeps a test only if it passes every
                                    run and fails when its check is broken on purpose.
      --move-to <folder>            Move kept tests there afterwards, leaving the project as it was.
      --mutate-source               Also change the code under test and check the test notices
                                    (unit tests only; needs the project's own mutation tool).
  tewip jira <plan.json> --project PROJ [--issue PROJ-123] [--create]
                                    File the plan's scenarios as test-case issues, linked to the
                                    story. Shows what it would create; --create actually files
                                    them, and the same scenario is never filed twice.
  tewip mcp                         Serve Tewip over MCP (stdio) for an editor or AI assistant.
  tewip --version                   Print the version.

Reports it reads: Playwright, pytest/unittest, Jest, Vitest, Mocha, node:test, JUnit/TestNG
(Maven, Gradle), Go (gotestsum), .NET (TRX or JUnit), RSpec, PHPUnit, Rust (nextest).
Set OPENAI_API_KEY to let the AI layer decide what the rules leave open.`;

const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
  switch (verb) {
    case 'explain': {
      // The explain script reads its arguments from process.argv, as when it is run directly.
      process.argv = [process.argv[0], 'tewip-explain', ...args];
      // Answers the AI layer already gave are kept with the project, not inside the installed tool.
      process.env.TEWIP_LLM_CACHE ??= join(process.cwd(), '.tewip', 'llm-cache.jsonl');
      await import('../scripts/explain.ts');
      return;
    }
    case 'ci': {
      const repo = args.find((a) => /^[\w.-]+\/[\w.-]+$/.test(a));
      if (!repo) throw new Error('usage: tewip ci <owner/repo> [--pr N | --branch B]');
      const pr = flag(args, 'pr');
      const { githubCiReport } = await import('../mcp/github-report.ts');
      console.log(await githubCiReport(repo, pr ? Number(pr) : undefined, flag(args, 'branch')));
      return;
    }
    case 'plan': {
      // A ticket says what was asked for better than a sentence typed twice: read it and plan from it.
      const issueKey = flag(args, 'issue');
      const typed = args.filter((a, i) => !a.startsWith('--') && !['--diff', '--url', '--out', '--issue'].includes(args[i - 1] ?? '')).join(' ').trim();
      let feature = typed;
      if (issueKey) {
        const { Jira, jiraFromEnv, jiraHelp } = await import('../engine/work/jira.ts');
        const { featureFromIssue } = await import('../engine/work/jira-command.ts');
        const config = jiraFromEnv();
        if (!config) throw new Error(jiraHelp());
        const issue = await new Jira(config).issue(issueKey);
        console.error(`Read ${issue.key} (${issue.type}, ${issue.status})${issue.acceptanceCriteria ? ' with its acceptance criteria' : ''}.`);
        feature = [featureFromIssue(issue), typed].filter(Boolean).join('\n\n');
      }
      if (!feature) throw new Error('usage: tewip plan "<what the feature does>" | --issue PROJ-123 [--diff main...HEAD] [--url http://localhost:3000/page ...] [--out plan.md]');
      const urls = args.flatMap((a, i) => (args[i - 1] === '--url' ? [a] : []));
      const { runPlan } = await import('../engine/quality/plan-command.ts');
      await runPlan({ feature, root: process.cwd(), diffRange: flag(args, 'diff'), urls, out: flag(args, 'out') });
      return;
    }
    case 'write': {
      const number = (name: string, fallback: number) => (flag(args, name) === undefined ? fallback : Math.max(0, Number(flag(args, name)) || 0));
      const { runWrite } = await import('../engine/quality/write-command.ts');
      await runWrite({
        root: process.cwd(),
        plan: flag(args, 'plan'),
        only: (flag(args, 'only') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        framework: flag(args, 'framework'),
        urls: args.flatMap((a, i) => (args[i - 1] === '--url' ? [a] : [])),
        runs: Math.max(1, number('runs', 3)),
        repairs: number('repairs', 2),
        max: Math.max(1, number('max', 10)),
        moveTo: flag(args, 'move-to') ? resolve(flag(args, 'move-to')!) : undefined,
        mutateSource: args.includes('--mutate-source'),
      });
      return;
    }
    case 'jira': {
      const planFile = args.find((a) => a.endsWith('.json'));
      const project = flag(args, 'project');
      if (!planFile || !project) throw new Error('usage: tewip jira <plan.json> --project PROJ [--issue PROJ-123] [--type "Test"] [--only QS-001,QS-002] [--create]');
      const { runJira } = await import('../engine/work/jira-command.ts');
      await runJira({
        planFile,
        projectKey: project,
        type: flag(args, 'type'),
        issueKey: flag(args, 'issue'),
        create: args.includes('--create'),
        only: (flag(args, 'only') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      });
      return;
    }
    case 'mcp':
      // An editor starts this from any folder, and an installed tool's own folder may be read-only:
      // the AI answer cache goes to the user's home folder, which is always writable.
      process.env.TEWIP_LLM_CACHE ??= join(homedir(), '.tewip', 'llm-cache.jsonl');
      await import('../mcp/server.ts');
      return;
    case '--version':
    case '-v':
      console.log(version());
      return;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      console.log(HELP);
      return;
    default:
      console.error(`tewip: unknown command "${verb}"\n\n${HELP}`);
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`tewip: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
