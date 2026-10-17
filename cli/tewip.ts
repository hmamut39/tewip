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
import { flag } from './args.ts';
import { HELP } from './help.ts';
import { proveVerb } from './verbs-prove.ts';
import { workVerb } from './verbs-work.ts';

// cli/ in the source tree, dist/cli/ in the published package: package.json is one or two levels up.
const ROOT = [join(import.meta.dirname, '..'), join(import.meta.dirname, '..', '..')].find((d) => existsSync(join(d, 'package.json'))) ?? join(import.meta.dirname, '..');
const version = (): string => (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;


async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
  // The verbs that reach into a tracker, a scan or a build live next door; the rest are here.
  if (await workVerb(verb, args)) return;
  // The verbs that prove a change live next door too.
  if (await proveVerb(verb, args)) return;
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
    case 'learn': {
      const { runLearn } = await import('../engine/learn/learn-command.ts');
      runLearn({ root: process.cwd(), name: flag(args, 'name'), labels: flag(args, 'labels'), out: flag(args, 'out') });
      return;
    }
    case 'pursue': {
      const goal = args.filter((a, i) => !a.startsWith('--') && !['--name', '--out'].includes(args[i - 1] ?? '')).join(' ').trim();
      if (!goal) throw new Error('usage: tewip pursue "<a goal, e.g. keep the checkout flow green>" [--act]');
      const { runPursue } = await import('../engine/pursue/pursue-command.ts');
      runPursue({ root: process.cwd(), goal, act: args.includes('--act'), name: flag(args, 'name'), out: flag(args, 'out') });
      return;
    }
    case 'trace': {
      const { runTrace } = await import('../engine/trace/trace-command.ts');
      runTrace({ root: process.cwd(), only: flag(args, 'only'), name: flag(args, 'name'), out: flag(args, 'out') });
      return;
    }
    case 'recall': {
      const question = args.filter((a, i) => !a.startsWith('--') && !['--test', '--limit', '--name', '--out'].includes(args[i - 1] ?? '')).join(' ').trim();
      if (!question) throw new Error('usage: tewip recall "<an error, or a question>" [--test "<test id>"] [--limit 5]');
      const { runRecall } = await import('../engine/recall/recall-command.ts');
      await runRecall({ root: process.cwd(), question, testId: flag(args, 'test'), limit: Number(flag(args, 'limit')) || undefined, name: flag(args, 'name'), out: flag(args, 'out') });
      return;
    }
    case 'incident': {
      const file = args.find((a, i) => !a.startsWith('--') && !['--framework', '--out'].includes(args[i - 1] ?? ''));
      if (!file) throw new Error('usage: tewip incident <sentry.json | otel.json | stack.txt> [--framework pytest] [--keep] [--out incident.md]');
      const { runIncident } = await import('../engine/incident/incident-command.ts');
      const result = await runIncident({ root: process.cwd(), file, framework: flag(args, 'framework'), keep: args.includes('--keep'), out: flag(args, 'out') });
      // A reproduction that was not reproduced is not a success, and a script should be able to tell.
      if (!result.kept) process.exitCode = 1;
      return;
    }
    case 'attest': {
      const verify = flag(args, 'verify');
      if (verify) {
        const { verifyAttestation } = await import('../engine/attest/attest-command.ts');
        const { ok, report } = verifyAttestation(verify, flag(args, 'key'));
        console.log(report);
        if (!ok) process.exitCode = 1;
        return;
      }
      const { runAttest } = await import('../engine/attest/attest-command.ts');
      runAttest({ root: process.cwd(), name: flag(args, 'name'), runId: flag(args, 'run'), out: flag(args, 'out'), json: flag(args, 'json') });
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
    // `tewip` on its own used to print 233 lines of help, which is a reference for somebody who
    // already knows what they want and a wall for everybody else. It now looks at the project and
    // names the two or three commands that will tell *this* team something. --help is unchanged
    // and still has all of it.
    case undefined:
    case 'start': {
      const { runStart } = await import('../engine/start/start-command.ts');
      runStart(process.cwd());
      return;
    }
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
