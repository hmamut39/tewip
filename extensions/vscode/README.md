# Tewip for VS Code, Cursor and Windsurf

**Tewip** (Uyghur for *healer*) finds why each failing test failed: a real bug, a flaky test, the environment, test data, or a changed selector. It works for Playwright, pytest, Jest, Vitest, JUnit, Go, .NET, Ruby, PHP and Rust.

This extension brings Tewip into the editor:

- **Your AI assistant can ask Tewip.** Tewip registers itself as an MCP server, so Copilot's agent mode (or your editor's assistant) can answer *"why did CI fail on my PR?"* with nothing to configure.
- **Tewip: Explain a test report…** Pick a JUnit XML or `.trx` report, or a Playwright blob-report folder, and read each failure's cause, confidence, evidence and next step.
- **Tewip: Why did CI fail on this branch?** Shows the latest report Tewip's GitHub Action posted for the branch you have checked out.
- **Tewip: Risk review of this change.** Before anyone reads your diff: which tests cover it and how, which of them have flaked before, what has gone wrong in these areas, what nothing tests at all, and the checks your change renegotiates.
- **Tewip: Which flaky tests to quarantine.** The dossier, with what each flaky test costs in CI time and the evidence behind the verdict.
- **Tewip: Check secrets and dependencies.** Credentials committed by accident and vulnerable packages, each judged for whether it can actually be reached - and it always says what was *not* checked.
- **Tewip: What our corrections add up to.** Where Tewip has been wrong in the same way more than once, so the rule gets fixed instead of the correction being re-entered.

## Requirements

- Node.js 22.18 or newer.
- The Tewip command line: `npm install -g tewip-ai`, or set **Tewip: Path** to `cli/tewip.ts` in a checkout.
- For CI reports: the GitHub CLI (`gh`), signed in.

Most of what Tewip answers costs nothing: three quarters of real failures are decided by deterministic rules that call no model at all. Set `OPENAI_API_KEY` only for the rest.

Tewip never changes your code from the editor. Its answers name their source (a rule, the AI, or a person's correction) and their confidence.
