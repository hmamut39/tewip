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
  tewip spec "<feature>" [--diff main...HEAD] [--url <page> ...] [--project PROJ] [--create]
                                    An epic, its user stories and their acceptance criteria, from
                                    this project's code, tests and failure history. Anything it
                                    says the system already does is quoted from a file it read;
                                    what it cannot quote becomes an open question. With --project it
                                    shows what it would file in Jira; --create files it.
  tewip report <report> [--gate] [--out report.md] [--name <project>] [--no-post]
                                    The CI command for any platform: GitLab CI, Jenkins, CircleCI,
                                    Azure, Bitbucket, Travis, Drone. Diagnoses the run, comments on
                                    the GitLab merge request, tells Slack or Teams only when a
                                    failure needs a person, and with --gate fails the build only on
                                    those failures.
  tewip watch [--cmd "npm test"] [--report <path>] [--paths src,tests]
                                    Beside your editor: runs your tests when a file changes (or
                                    watches for new reports) and explains each failure as it
                                    happens, without CI.
  tewip note [--days 7] [--name <project>] [--out note.md] [--post]
                                    The weekly quality note for a lead, written from the runs Tewip
                                    already diagnosed. No model calls, so it costs nothing.
  tewip fix --code <report> [--only "<test title>"] [--max 3] [--apply] [--suite "<command>"]
                                    Opt-in: for failures diagnosed as a real bug, propose the
                                    smallest change to application code, and keep it only if the
                                    failing test then passes AND the whole suite still passes. The
                                    change is written as a patch; nothing is committed or merged.
  tewip design <figma link | frame.json> [--url <page>] [--frame "<name>"] [--out drift.md]
                                    Compare a Figma frame against the running page: the words the
                                    design specifies and the controls its layer names imply. Says
                                    "the design says X, the page says Y". No model, no cost.
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
    case 'spec': {
      const feature = args.filter((a, i) => !a.startsWith('--') && !['--diff', '--url', '--out', '--project'].includes(args[i - 1] ?? '')).join(' ').trim();
      if (!feature) throw new Error('usage: tewip spec "<what the feature should do>" [--diff main...HEAD] [--url http://localhost:3000/page] [--project PROJ] [--create]');
      const { runSpec } = await import('../engine/spec/spec-command.ts');
      await runSpec({
        feature,
        root: process.cwd(),
        diffRange: flag(args, 'diff'),
        urls: args.flatMap((a, i) => (args[i - 1] === '--url' ? [a] : [])),
        out: flag(args, 'out'),
        projectKey: flag(args, 'project'),
        create: args.includes('--create'),
      });
      return;
    }
    case 'report': {
      const report = args.find((a, i) => !a.startsWith('--') && !['--out', '--name'].includes(args[i - 1] ?? ''));
      if (!report) throw new Error('usage: tewip report <report.xml | reports-dir | blob-report-dir> [--gate] [--out report.md] [--name project] [--no-post]');
      process.env.TEWIP_LLM_CACHE ??= join(process.cwd(), '.tewip', 'llm-cache.jsonl');
      const { runReport } = await import('../engine/ci/report-command.ts');
      const result = await runReport({
        root: process.cwd(),
        report,
        name: flag(args, 'name'),
        out: flag(args, 'out'),
        gate: args.includes('--gate'),
        post: !args.includes('--no-post'),
      });
      // The gate fails the build only for failures that are not known flaky or environment noise.
      if (args.includes('--gate') && result.blocking > 0) process.exitCode = 1;
      return;
    }
    case 'watch': {
      const { runWatch } = await import('../engine/watch/watch-command.ts');
      await runWatch({
        root: process.cwd(),
        cmd: flag(args, 'cmd'),
        report: flag(args, 'report'),
        paths: (flag(args, 'paths') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        once: args.includes('--once'),
      });
      return;
    }
    case 'note': {
      const { runNote } = await import('../engine/notify/note-command.ts');
      await runNote({
        root: process.cwd(),
        name: flag(args, 'name'),
        days: Math.max(1, Number(flag(args, 'days')) || 7),
        out: flag(args, 'out'),
        post: args.includes('--post'),
      });
      return;
    }
    case 'fix': {
      // Changing application code is the one thing Tewip has always refused, so it happens only
      // when a person asks for it by name. Without --code, this says so rather than guessing.
      if (!args.includes('--code')) throw new Error('usage: tewip fix --code <report> [--only "<test title>"] [--max 3] [--apply]\n\nTewip only changes application code when you ask for it with --code, and only for failures it diagnosed as a real bug. Locator and wait fixes to tests are made by the GitHub Action, not here.');
      const report = args.find((a, i) => !a.startsWith('--') && !['--only', '--max', '--suite'].includes(args[i - 1] ?? ''));
      if (!report) throw new Error('usage: tewip fix --code <report.xml | reports-dir | blob-report-dir>');
      process.env.TEWIP_LLM_CACHE ??= join(process.cwd(), '.tewip', 'llm-cache.jsonl');
      const { runCodeFix } = await import('../engine/autofix/code-command.ts');
      await runCodeFix({
        root: process.cwd(),
        report,
        only: (flag(args, 'only') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        max: Math.max(1, Number(flag(args, 'max')) || 3),
        apply: args.includes('--apply'),
        suiteCommand: flag(args, 'suite'),
      });
      return;
    }
    case 'design': {
      const design = args.find((a, i) => !a.startsWith('--') && !['--url', '--frame', '--out', '--max'].includes(args[i - 1] ?? ''));
      if (!design) throw new Error('usage: tewip design <figma link | frame.json> [--url http://localhost:3000/page] [--frame "Checkout"] [--out drift.md]');
      const { runDesign } = await import('../engine/design/design-command.ts');
      await runDesign({
        design,
        url: flag(args, 'url'),
        frame: flag(args, 'frame'),
        out: flag(args, 'out'),
        max: flag(args, 'max') ? Number(flag(args, 'max')) : undefined,
        root: process.cwd(),
      });
      // A difference is a finding, not a failure: the command succeeds either way, so a team can run
      // it in CI without the build going red over a design decision nobody has made yet.
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
