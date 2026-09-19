#!/usr/bin/env node
// Tewip on the command line. One command, a few verbs:
//   tewip explain <report>          why each test in a report failed, and what to do next
//   tewip ci <owner/repo> [--pr N]  the latest Tewip report from a repository's CI
//   tewip mcp                       serve Tewip to an AI assistant or editor over MCP (stdio)
//   tewip --version | --help
// The verbs reuse the same code as the GitHub Action and the MCP server: one engine, many outlets.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    case 'mcp':
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
