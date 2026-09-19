# Tewip for VS Code, Cursor and Windsurf

**Tewip** (Uyghur for *healer*) finds why each failing test failed: a real bug, a flaky test, the environment, test data, or a changed selector. It works for Playwright, pytest, Jest, Vitest, JUnit, Go, .NET, Ruby, PHP and Rust.

This extension brings Tewip into the editor:

- **Your AI assistant can ask Tewip.** Tewip registers itself as an MCP server, so Copilot's agent mode (or your editor's assistant) can answer *"why did CI fail on my PR?"* with nothing to configure.
- **Tewip: Explain a test report…** Pick a JUnit XML or `.trx` report, or a Playwright blob-report folder, and read each failure's cause, confidence, evidence and next step.
- **Tewip: Why did CI fail on this branch?** Shows the latest report Tewip's GitHub Action posted for the branch you have checked out.

## Requirements

- Node.js 22.18 or newer.
- The Tewip command line: `npm install -g tewip-<version>.tgz` (from the release; Tewip is not on the npm registry yet), or set **Tewip: Path** to `cli/tewip.ts` in a checkout.
- For CI reports: the GitHub CLI (`gh`), signed in.

Tewip never changes your code from the editor. Its answers name their source (a rule, the AI, or a person's correction) and their confidence.
