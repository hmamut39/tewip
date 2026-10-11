# Tewip for VS Code, Cursor and Windsurf

**Tewip** (Uyghur for *healer*) answers the questions a team actually argues about before a release: is this done, can these tests fail at all, what will this migration do to the live database, who cannot use this interface, and is it slower than it was.

Every answer carries its evidence, names its source - a rule, a model, or a person's correction - and says what it did **not** check. It answers "cannot say" rather than guessing, and it never rounds "cannot say" up to ready.

Tewip never changes your code from the editor.

## The verdicts

- **Is this work done?** One verdict over your current change: is anything failing, is the changed code tested by something that really reaches it, can the tests in it fail at all, and does it keep this project's own standards. Ready, not ready, or cannot say.
- **Could these tests ever fail?** Reads the open test file and names the tests that check nothing, compare a value with itself, swallow their own failure, or are quietly skipped. Measured on 18,457 tests in real Python and Java codebases with zero false accusations.
- **Would the tests catch a bug in this file?** Breaks the open file in small deliberate ways, runs the tests that cover it, and reports every change none of them noticed. Slow by nature, and your file is put back exactly as it was.
- **Which tests could notice this change?** Narrows a test run from facts in the source, and refuses to narrow when it cannot show the rest are unaffected.
- **What will this migration do to a live database?** Names what breaks the version still running, destroys data, blocks writes, or cannot be undone - and finds code that still uses a column being dropped. Reads plain SQL plus Django, Rails, Alembic, Laravel, TypeORM, Sequelize, Knex, EF Core and Liquibase.
- **Can everybody use this?** Names who cannot use the interface and the WCAG 2.2 criterion a regulator would cite under the European Accessibility Act - in HTML, JSX, Vue, Svelte, Astro, ERB, Blade, Twig, Jinja, Razor and Handlebars. It reads a Lighthouse report as evidence too.
- **Is this change slower?** Judges a k6, JMeter (`.jtl`) or Lighthouse report you already produced rather than restating it, and separates a difference that is statistically real from one that is large enough to matter. It refuses to call a change slower on too few samples.
- **This project's own standards.** House rules written as plain markdown in `.tewip/standards/`, enforced on the change in front of you.

## The rest

- **Your AI assistant can ask Tewip.** It registers itself as an MCP server, so Copilot's agent mode or your editor's assistant can answer *"why did CI fail on my PR?"* with nothing to configure.
- **Explain a test report.** A JUnit XML, a `.trx`, or a Playwright blob-report folder: each failure's cause, confidence, evidence and next step. Playwright, pytest, Jest, Vitest, JUnit, Go, .NET, Ruby, PHP and Rust.
- **Why did CI fail on this branch?** The latest report Tewip's GitHub Action posted for the branch you have checked out.
- **Risk review of this change.** Before anyone reads your diff: which tests cover it and how, which have flaked before, what has gone wrong in these areas, what nothing tests at all.
- **Which flaky tests to quarantine.** What each one costs in CI time, and the evidence behind the verdict.
- **Check secrets and dependencies.** Credentials committed by accident and vulnerable packages, each judged for whether it can actually be reached.
- **What our corrections add up to.** Where Tewip has been wrong in the same way more than once, so the rule gets fixed instead of the correction being re-entered.
- **Has this happened here before?** Paste an error, or ask in plain words, and get the earlier failures that resemble it, what was decided and by which rule or person. No model is called.
- **Is this requirement covered, and passing?** The thread from the plan someone asked for to the test that covers it. A scenario counts as covered only when a real test can be named.
- **What should be done next about...?** Give it a goal and it says what it would do next and why, in a fixed published order. It decides; it never changes a file.
- **What did Tewip check for this build?** One artifact with the claims and their evidence, what it refused to decide, and what it did not check at all.

## Requirements

- Node.js 22.18 or newer.
- The Tewip command line: `npm install -g tewip-ai`, or set **Tewip: Path** to `cli/tewip.ts` in a checkout.
- For CI reports: the GitHub CLI (`gh`), signed in.

The extension is a thin shell over that command line, so updating `tewip-ai` updates what every command here can do, with no new version of this extension.

Most of what Tewip answers costs nothing: three quarters of real failures are decided by deterministic rules that call no model at all. Set `OPENAI_API_KEY` only for the rest.

## Also available as

A command line (`npm install -g tewip-ai`), a [GitHub Action](https://github.com/marketplace/actions/tewip) that runs these same checks on every pull request, an MCP server, and an A2A agent other agents can query.

Built by Mamuti Aishan (Hasan). Source and issues: [github.com/hmamut39/tewip](https://github.com/hmamut39/tewip).
