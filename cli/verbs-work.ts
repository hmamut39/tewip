// The verbs that talk to the tools a team already runs on: the tracker, the security scan, the
// specification, the CI report, and building a feature from a ticket. Split out of cli/tewip.ts to
// keep both files readable; the dispatch is the same switch, one level down.
import { join } from 'node:path';
import { flag } from './args.ts';

/** Runs `verb` if it is one of these, and says whether it did. */
export async function workVerb(verb: string, args: string[]): Promise<boolean> {
  switch (verb) {
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
      return true;
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
      return true;
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
      return true;
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
      return true;
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
      return true;
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
        return true;
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
      return true;
    }
    default:
      return false;
  }
}
