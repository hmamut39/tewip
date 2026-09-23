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
      --export xray|zephyr          Write the cases as a CSV for Xray or Zephyr Scale instead.
                                    No account needed; importing stays your step.
  tewip bugs <report> --project PROJ [--create] [--max 5]
                                    File a bug ticket for each failure Tewip diagnosed as a real
                                    bug, with its evidence and run link. A flaky test or a broken
                                    environment is deliberately not filed, and the same failure is
                                    never filed twice.
  tewip secure [--url http://localhost:3000] [--secrets-only] [--gate] [--out security.md]
                                    Runs the scanners this project already has (npm audit,
                                    pip-audit, osv-scanner) plus Tewip's own secret scan, then says
                                    which findings need someone now and which are noise or not
                                    reachable. No model, no cost, and it never prints a credential.
      --url <page>                  Also check the running app: security headers, cookie flags, and
                                    files that must never be served (.env, .git). Ordinary requests
                                    only. An address that is not this machine needs
                                    --i-am-authorised.
      --zap-report zap.json         Triage the findings of an OWASP ZAP baseline scan as well.
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
  tewip build "<what it should do>" | --issue PROJ-123 [--dry-run] [--pr] [--out feature.patch]
                                    Writes a feature, test first: the test must fail without the
                                    code and pass with it, and every test that was passing must
                                    still pass - otherwise everything goes back byte for byte.
      --issue PROJ-123              Build from the ticket itself: its description and acceptance
                                    criteria. Works with a public tracker without an account.
      --pr                          Commit the proved work on a branch of its own and open a draft
                                    pull request. Never merges, never commits to your branch.
  tewip review [--diff main...HEAD] [--out review.md]
                                    Before anyone reads the diff: which tests cover this change,
                                    which of them have flaked before, what has gone wrong in these
                                    areas, what nothing tests at all, and the command that runs the
                                    telling tests first. From this project's own history, so it
                                    costs nothing.
  tewip watch [--cmd "npm test"] [--report <path>] [--paths src,tests]
                                    Beside your editor: runs your tests when a file changes (or
                                    watches for new reports) and explains each failure as it
                                    happens, without CI.
  tewip flaky [--days 30] [--apply] [--name <project>] [--out flaky.md]
                                    Which tests are wasting the team's time, how much CI time they
                                    cost, and what to do with each: quarantine, fix, or watch. Read
                                    from runs already diagnosed, so it costs nothing. --apply puts
                                    the quarantine line in the test file with the evidence above it.
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
  tewip correct <kind> "<what>" <verdict> ["why"] | --list
                                    Tell Tewip it was wrong, about anything it decides: a diagnosis,
                                    a flaky verdict, a security finding, a design difference, a
                                    refused build. It answers with your decision from then on, and
                                    says it was yours. It never acts on a correction by itself.
  tewip mcp                         Serve Tewip over MCP (stdio) for an editor or AI assistant.
  tewip --version                   Print the version.

Reports it reads: Playwright, pytest/unittest, Jest, Vitest, Mocha, node:test, JUnit/TestNG
(Maven, Gradle), Go (gotestsum), .NET (TRX or JUnit), NUnit 3, RSpec, PHPUnit, Rust (nextest),
Robot Framework (output.xml), JMeter (.jtl) and k6 (--summary-export). Appium, Selenium and
WebdriverIO suites report through one of the above, and their own error messages are understood.
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
      // Writing a file for a test-management tool needs no project at all.
      if (!planFile || (!project && !flag(args, 'export'))) {
        throw new Error(['usage: tewip jira <plan.json> --project PROJ [--issue PROJ-123] [--only QS-001,QS-002] [--create]', '   or: tewip jira <plan.json> --export xray|zephyr [--out cases.csv]'].join('\n'));
      }
      const { runJira } = await import('../engine/work/jira-command.ts');
      const exportAs = flag(args, 'export');
      if (exportAs && exportAs !== 'xray' && exportAs !== 'zephyr') throw new Error('--export takes xray or zephyr');
      await runJira({
        planFile,
        // An export needs no project at all; filing into Jira has already been checked to have one.
        projectKey: project ?? '',
        exportAs: exportAs as 'xray' | 'zephyr' | undefined,
        out: flag(args, 'out'),
        type: flag(args, 'type'),
        issueKey: flag(args, 'issue'),
        create: args.includes('--create'),
        only: (flag(args, 'only') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      });
      return;
    }
    case 'bugs': {
      const report = args.find((a, i) => !a.startsWith('--') && !['--project', '--max'].includes(args[i - 1] ?? ''));
      const project = flag(args, 'project');
      if (!report || !project) throw new Error('usage: tewip bugs <report.xml | reports-dir | blob-report-dir> --project PROJ [--create] [--max 5]');
      process.env.TEWIP_LLM_CACHE ??= join(process.cwd(), '.tewip', 'llm-cache.jsonl');
      const { runBugs } = await import('../engine/work/bug-command.ts');
      await runBugs({
        root: process.cwd(),
        report,
        projectKey: project,
        create: args.includes('--create'),
        max: Math.max(1, Number(flag(args, 'max')) || 5),
      });
      return;
    }
    case 'secure': {
      const { runSecure } = await import('../engine/secure/secure-command.ts');
      const items = await runSecure({
        root: process.cwd(),
        out: flag(args, 'out'),
        secretsOnly: args.includes('--secrets-only'),
        gate: args.includes('--gate'),
        url: flag(args, 'url'),
        authorised: args.includes('--i-am-authorised'),
        zapReport: flag(args, 'zap-report'),
      });
      // The gate fails a build only for what Tewip decided a person must act on now.
      if (args.includes('--gate') && items.some((i) => i.verdict === 'real-risk')) process.exitCode = 1;
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
    case 'build': {
      const typed = args.filter((a, i) => !a.startsWith('--') && !['--repairs', '--out', '--max-lines', '--issue'].includes(args[i - 1] ?? '')).join(' ').trim();
      const issueKey = flag(args, 'issue');
      let feature = typed;
      let issueTitle = '';
      if (issueKey) {
        // A ticket says what was asked for better than a sentence typed twice.
        const { Jira, jiraFromEnv, jiraHelp } = await import('../engine/work/jira.ts');
        const { featureFromIssue } = await import('../engine/work/jira-command.ts');
        const config = jiraFromEnv();
        if (!config) throw new Error(jiraHelp());
        const issue = await new Jira(config).issue(issueKey);
        console.error(`Read ${issue.key} (${issue.type}, ${issue.status})${issue.acceptanceCriteria ? ' with its acceptance criteria' : ''}.`);
        issueTitle = `${issue.key}: ${issue.summary}`;
        feature = [featureFromIssue(issue), typed].filter(Boolean).join('\n\n');
      }
      if (!feature) throw new Error('usage: tewip build "<what the feature should do>" | --issue PROJ-123 [--dry-run] [--pr] [--out feature.patch]');
      const { runBuild, renderBuild } = await import('../engine/build/build-command.ts');
      const dryRun = args.includes('--dry-run');
      const result = await runBuild({
        feature,
        root: process.cwd(),
        dryRun,
        repairs: flag(args, 'repairs') === undefined ? 2 : Math.max(0, Number(flag(args, 'repairs')) || 0),
        maxLines: flag(args, 'max-lines') ? Number(flag(args, 'max-lines')) : undefined,
        out: flag(args, 'out'),
      });
      console.log(`
${renderBuild(result, issueTitle || feature, dryRun)}`);
      if (result.status !== 'built') {
        process.exitCode = 1;
        return;
      }
      if (args.includes('--pr')) {
        if (dryRun) throw new Error('--pr and --dry-run ask for opposite things: one keeps the work, the other puts it back.');
        const { proposePullRequest } = await import('../engine/build/propose-pr.ts');
        const proposed = proposePullRequest({
          root: process.cwd(),
          files: result.files,
          title: (issueTitle || feature.split('\n')[0]).slice(0, 72),
          body: result.why,
          issue: issueKey,
        });
        console.log(`
${proposed.status === 'opened' ? 'Opened a draft pull request.' : proposed.status === 'committed' ? `Committed on ${proposed.branch}.` : 'No pull request was opened.'}`);
        for (const line of proposed.next) console.log(`  ${line}`);
      }
      return;
    }
    case 'review': {
      const { runReview } = await import('../engine/review/review-command.ts');
      await runReview({
        root: process.cwd(),
        diff: flag(args, 'diff') ?? 'main...HEAD',
        out: flag(args, 'out'),
        name: flag(args, 'name'),
      });
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
    case 'flaky': {
      const { runFlaky } = await import('../engine/flaky/flaky-command.ts');
      await runFlaky({
        root: process.cwd(),
        name: flag(args, 'name'),
        days: Math.max(1, Number(flag(args, 'days')) || 30),
        apply: args.includes('--apply'),
        out: flag(args, 'out'),
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
    case 'correct': {
      const { runCorrect } = await import('../engine/learn/correct-command.ts');
      const words = args.filter((a) => !a.startsWith('--'));
      console.log(
        runCorrect({
          root: process.cwd(),
          kind: words[0] ?? '',
          key: words[1],
          verdict: words[2],
          reason: words.slice(3).join(' ') || undefined,
          list: args.includes('--list'),
          by: flag(args, 'by'),
        }),
      );
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
