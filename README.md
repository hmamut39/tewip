# Tewip

**Tewip** (Uyghur *téwip*, تېۋىپ: healer, doctor) finds why each failing test failed: a real bug, a flaky test, the environment, test data, or a changed selector. Every answer comes with its confidence, its evidence and one next step, and names its source: a deterministic rule, the AI model, or a person's correction.

It works for every stack: Node.js (node:test, Jest, Vitest, Mocha), Python (pytest, unittest), Java and Kotlin (JUnit, TestNG), Go, .NET, Ruby, PHP and Rust, each checked against its real runner's report ([the full list](QUICKSTART.md#not-using-playwright-every-stack-works)), plus Playwright in depth with traces, selector drift and verified fixes.

| Where | How |
|---|---|
| **Terminal** | `npm install -g tewip-<version>.tgz` (from the release; Tewip is not on the npm registry yet), then `tewip explain report.xml`, `tewip ci owner/repo --pr 12`, `tewip mcp` |
| **VS Code, Cursor, Windsurf, VSCodium** | the Tewip extension: registers Tewip with the editor's AI assistant and adds *Explain a test report* and *Why did CI fail on this branch?* |
| **JetBrains, Claude, other AI assistants** | add the MCP server `tewip mcp` (see [editor setup](#use-it-from-your-editor-any-ide-that-speaks-mcp)) |
| **GitHub CI** | the Tewip Action: a comment on every pull request, an optional merge gate, verified fix PRs ([QUICKSTART](QUICKSTART.md)) |

Formerly *triage-agent*: the repository moved to `hmamut39/tewip`, and GitHub redirects the old address. See [ROADMAP.md](ROADMAP.md) for the plan.

**Status: phases 1 to 4 are built, and Phase 5 (auto-fix) is in progress.** Those phases are collection, rule-based diagnosis, LLM diagnosis with a real-data eval, and multi-role views. It runs live in GitHub CI and answers questions from AI assistants through MCP. On fresh real Gutenberg CI failures, with the pipeline frozen before labelling, accuracy is 93.4%; the caveats are in [eval/README.md](eval/README.md).

## Use it in your project

**Putting it on a real repository: [QUICKSTART.md](QUICKSTART.md)** — ten minutes, copy-paste, and what to check on the first failing run.

### 1. In GitHub CI (developers, SDETs, DevOps)

Tell Playwright to write a blob report in CI. It's a built-in reporter, so there's no triage-agent code in your config:

```ts
// playwright.config.ts
reporter: process.env.CI ? [['list'], ['blob']] : 'list',
use: { trace: 'retain-on-failure' },
```

Then add one step after your tests:

```yaml
permissions:
  contents: write        # only needed for autofix
  pull-requests: write
  issues: write

steps:
  # ... checkout, install, npx playwright test ...
  - name: triage-agent
    if: always()
    uses: hmamut39/tewip@main
    with:
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}   # optional: without it only the rules run
      autofix: 'true'                                  # optional: verified locator-fix PRs
```

On every run, the action:
- **Developers:** posts one diagnosis comment on the pull request and keeps it updated. For each failure it says whether the change likely caused it, why, and what to do next.
- **SDETs:** writes the triage board into the job summary.
- **DevOps:** collects environment failures (server errors, connection resets, outages) in **one** GitHub issue, and each new run adds a single grouped comment to it.
- **Fixes (`autofix: true`):** for drifted locators that the deterministic rule matched to a renamed element, it rewrites the locator, re-runs that test, and opens a separate pull request with the changes that passed. It never merges and never edits application code.
- **Every role:** uploads all role views as the `triage-agent-report` artifact.
- **History:** keeps the run history in the Actions cache, never in git.
- **Corrections:** reply to the agent's comment with `/triage CATEGORY #n reason` (e.g. `/triage TIMING #2 flaky on CI`). It stores that with the history and, next time that test fails the same way, gives the person's answer instead of its own, naming them and their reason. A corrected failure also costs nothing: it never goes to the model again.

For **senior engineers, architects and leads**, add a scheduled workflow with `mode: report`, for example weekly. It builds the engineering-quality, architecture and risk-digest views from the stored CI history, reusing earlier diagnoses so it makes no repeat AI calls. The views are kept in one GitHub issue that each report updates:

```yaml
on:
  schedule: [{ cron: '0 6 * * 1' }]
  workflow_dispatch:
permissions: { contents: read, issues: write }
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: hmamut39/tewip@main
        with: { mode: report }
```

The report reads the history cache of the branch it runs on, usually the default branch.

The repository needs "Allow GitHub Actions to create and approve pull requests" enabled for fix PRs. Pull requests opened by the workflow token don't trigger CI themselves; the agent verified each change by re-running the test before opening the PR. See [triage-agent-sandbox](https://github.com/hmamut39/triage-agent-sandbox) for a working example. If this repository is private, other repositories can only use the action when Settings → Actions → Access allows it.

### 2. From any AI assistant, through MCP (the whole IT team)

`mcp/server.ts` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server. Anyone on the team can ask their own assistant about test failures, in the editor or chat they already use:

| Ask your assistant | Tool it uses |
|---|---|
| "Why did CI fail on PR 12 in our-org/web?" | `github_ci_report`: the latest CI report for that PR, plus any verified fix PR |
| "Explain the failing checkout test" | `explain_failure`: root cause, confidence, evidence, history on this commit vs others, next action |
| "What should I fix first from the last run?" | `triage_board` (SDET) · `pr_impact` (developer) |
| "Is the test environment broken?" | `environment_report` (DevOps / SRE) |
| "Can we release?" | `release_readiness` (business / UAT) |
| "Where is our test suite fragile?" | `quality_report` (senior / principal) · `architecture_report` (architect) · `risk_digest` (lead) |

Setup, after `npm install`:

- **Claude Code** in this repo: [.mcp.json](.mcp.json) is already here, so approve `triage-agent` when asked. From anywhere else, run `claude mcp add triage-agent -- node /path/to/triage-agent/mcp/server.ts`.
- **Claude Desktop, Cursor, VS Code, and other MCP clients:** add a stdio server with command `node` and args `["/path/to/triage-agent/mcp/server.ts"]`.

`github_ci_report` uses the `gh` CLI login on your machine. The other tools read the datasets under `data/`, and the AI layer uses `OPENAI_API_KEY` from `.env`.

## Use it from your editor (any IDE that speaks MCP)

**VS Code, Cursor, Windsurf and VSCodium:** install the Tewip extension (`extensions/vscode`, packaged as `tewip-<version>.vsix`: *Extensions → … → Install from VSIX*). It registers Tewip as an MCP server by itself, so the assistant can use it with no configuration, and adds two commands: *Tewip: Explain a test report…* and *Tewip: Why did CI fail on this branch?*

**Every other MCP client** (JetBrains IDEs 2025.2+, Claude Code, Claude Desktop, or an editor without the extension) takes one entry. With Tewip installed from its release file (`npm install -g tewip-<version>.tgz`), the command is simply `tewip mcp`; from a checkout, point at `cli/tewip.ts`:

Point the entry at this checkout with an absolute path (the server resolves its own data, so the editor's working directory does not matter). **VS Code** uses its own shape, with a `servers` key and a `type`; put it in the workspace's `.vscode/mcp.json`, or in your user-level configuration (command *MCP: Open User Configuration*) to have it in every window:

```json
{
  "servers": {
    "tewip": { "type": "stdio", "command": "tewip", "args": ["mcp"] }
  }
}
```

**Cursor, Claude Desktop, Windsurf and most other clients** use the `mcpServers` shape (Cursor: Settings → MCP):

```json
{
  "mcpServers": {
    "tewip": { "command": "tewip", "args": ["mcp"] }
  }
}
```

- **JetBrains** (IntelliJ, WebStorm, PyCharm 2025.2+): Settings → Tools → MCP Server.
- **Inside this repository** nothing is needed for Claude Code: `.mcp.json` is already set up.

Then ask, in plain language: *"why did CI fail on my PR?"*, *"which tests are flaky in checkout?"*, *"is the main branch safe to release?"*. Every tool is read-only, and `github_ci_report` reads the report the Action uploaded, so you can ask about a repository's CI **without cloning it or opening the Actions page** (it uses your `gh` login).

## Where it has been tried

| Project | How | Result |
|---|---|---|
| [triage-agent-sandbox](https://github.com/hmamut39/triage-agent-sandbox) (private practice repo) | Live GitHub Action on a release PR with 11 planted failures | Diagnosis comment, one environment issue, and a fix PR whose 5 locator changes pass when checked out. Traps left alone. Synthetic. |
| WordPress Gutenberg (public) | Offline, from 5 windows of real CI blob reports, two of them harvested after the pipeline was frozen | 84–98% accuracy on 1,441 labelled real failures; the only project with enough drift cases to measure that category (see [eval/README.md](eval/README.md) for caveats) |
| JupyterLab (public) | Offline, from its Galata UI suite | 90.2% on 41 labelled failures; the deterministic rules alone were right on 34 of 34 they decided |
| LXD UI (public) | Offline, from its pull-request suite | 91.3% on 69 labelled failures; rules right on 63 of 63. All 6 misses are cross-branch flakes read as real bugs |
| Supabase Studio (public) | Shadow run: real CI blob reports, nothing posted to the project | REAL_BUG 6/6, TEST_DATA 6/6; the TIMING majority shares its signal with the labels |
| Penpot (public) | Shadow run over 21 runs that were still downloadable | Works on a third project; only 5 labelled cases, too few to score |
| Nextcloud server (public) | Attempted | Harvests fine (45 failures) but only 1 case had the evidence to label in the window: too sparse to score |
| Ghost (public) | Attempted | **Not usable from outside**: Ghost uploads blob reports only for failed runs and keeps them about a day, so 3 of 255 runs survived |

Shadow runs are how the agent is tried on public projects without touching them: `npm run harvest -- <source>`, then `node scripts/shadow.ts <source> [--publish your/private-repo]`.

## How it compares (September 2026)

Other tools cover parts of this job. This table is what each is known for from its own public material, and where triage-agent differs; it is not a benchmark of them.

| Tool | What it does | Where triage-agent differs |
|---|---|---|
| [Playwright Test Agents](https://playwright.dev) — the Healer | Rewrites a broken selector and re-runs the test; its makers report about 75% success on selector failures | triage-agent first decides **whether** it is a changed selector at all (real bug, race, environment and test data are ruled out first), then fixes only what a deterministic rule matched and a re-run proved: 14 real fixes with none wrong. A healer that repairs every selector failure will also "repair" a removed feature |
| [Trunk](https://docs.trunk.io/flaky-tests/detection), [BuildPulse](https://buildpulse.io/products/flaky-tests), [Datadog Test Optimization](https://www.getpanto.ai/blog/best-flaky-test-tools) | Detect flaky tests from pass/fail history and quarantine them so they stop blocking merges | Same core signal (a test that failed and passed on the same code), plus a cause for **every** failure, not only flaky ones, and a per-failure merge gate. Measured on 2,296 real failures (below) |
| [ReportPortal](https://reportportal.io/docs/analysis/AutoAnalysisOfLaunches/) | Classifies failures as product bug, automation bug or system issue by matching earlier human classifications | Same idea of learning from people (`/triage` corrections), plus deterministic rules that need no training data, so it is useful from the first run |
| [Develocity](https://develocity.ai/product/failure-analytics/) | Groups build and test failures by root cause across history (Gradle and Maven) | Any language through JUnit XML or TRX, and it acts on each failure: comment, grouped environment issue, verified fix, gate |

What it does not have, and they do: dashboards and hosted history (it keeps history in the Actions cache), and years of production use.

## Smart merge gate

With `gate: real-failures`, the triage step fails the build only when a failing test needs someone: a real bug, a changed selector, a test-data problem, or anything undecided. Failures that a deterministic rule or a person classified as flaky or environment do not block. AI-only verdicts still block, because the model is the less reliable half.

```yaml
      - name: Tests
        continue-on-error: true      # let the gate decide the outcome
        run: npx playwright test     # or pytest, jest, mvn test, go test ...
      - name: triage-agent
        if: always()
        uses: hmamut39/tewip@main
        with:
          gate: real-failures
```

Measured on 2,296 labelled real failures from five projects, the gate lets **1,823** failures through and **none of them is a real bug**, a changed selector or a test-data problem; **84%** of all flaky and environment failures (1,823 of 2,160) stop blocking merges. Read the zero with care: the first measurement let one real bug through (a new test on a feature branch hit a server error from new backend code), and the server-error rule was then changed to step back when a test has never passed. The zero is measured on the same data that exposed the gap, so it is optimistic; the weekly job keeps checking it on new data. The counts are also step outputs (`blocking`, `flaky`, `environment`) for later steps to use.

## How it works

- `reporters/triage-reporter.ts` is a custom Playwright reporter. It runs alongside `list`. For every attempt with status `failed` or `timedOut`, it captures the error, stack, duration, retry, trace, screenshot and `error-context.md` paths, run id and git SHA. It runs the rule engine on each failure and **appends** the records, each with its `diagnosis`, to `data/triage.jsonl`. It also appends one summary line per run to `data/runs.jsonl`, which records how many times each test ran.
- `engine/` is the phase-2 rule engine. It is deterministic: the same failure and history always give the same answer. It classifies a failure into one of the five root causes (`REAL_BUG`, `LOCATOR_DRIFT`, `TIMING`, `ENV`, `TEST_DATA`) with a confidence and evidence. If no rule can decide, it returns `UNKNOWN` with confidence 0, along with what each rule saw, for phase 3.
- `engine/llm/` + `engine/trace/` make up the phase-3 LLM layer. It only sees failures the rules left `UNKNOWN`. It reads `trace.zip` (the final DOM, failed requests, console errors, test steps) and `error-context.md` (the page snapshot and the failing code line, with comments stripped). It builds a short structured summary, not raw logs, and asks the model for a strict JSON answer that must be one of the five categories. The answer is checked again locally. If the call fails or the answer is invalid, the failure stays `UNKNOWN`. `engine/pipeline.ts` runs rules and then the LLM, and the reporter, CLI and eval all use it.
- `eval/` holds the ground-truth labels and `evaluate.ts`, which prints the phase-3 accuracy metric. `eval/harvest/` imports real CI runs from public repos. See [eval/README.md](eval/README.md).
- `engine/decide.ts` is the agent's DECIDE step. It turns each diagnosis into a next action following the autonomy table in ROADMAP.md: fix a locator or a fixed wait, re-run and notify, fix the test setup, file a bug, or escalate to a human. Low confidence (below 0.5) always escalates. Code fixes are only agent-eligible above 0.85. Nothing is executed yet: acting comes with Phase 5.
- `outlets/` holds the Phase 4 views. Every view renders the same `TriageItem`: diagnosis, next action, confidence, data source and evidence. `npm run triage` writes them as markdown under `data/reports/<dataset>/` (gitignored).

  | Role | View | Scope |
  |---|---|---|
  | Developer | `pr-comment.md`: which failures are likely caused by this change, and why | each failed run |
  | SDET | `sdet-board.md`: every failure grouped by next action | each failed run |
  | DevOps / SRE | `infra.md`: environment failures grouped by what broke, retry recovery, one grouped alert | each failed run |
  | Business / UAT | `release.md`: READY / WAIT / NOT READY in plain words | each failed run |
  | Senior / principal engineers | `quality.md`: flakiness hotspots, recurring patterns, test-design debt ranked by CI time lost | whole window |
  | Architects | `architecture.md`: fragility by area, single commits that broke many suites, failing dependencies | whole window |
  | Leads / managers | `digest.md`: areas whose failure rate grew between the first and second half of the window | whole window |
- `scripts/history.ts` groups the records by test and prints failure rates. A test is flagged `SUSPECTED_FLAKY` when its failure rate is between 20% and 80% and its error messages vary.
- `scripts/diagnose.ts` runs the engine over every collected failure and prints the phase-2 metric (coverage), labelled with the dataset it came from.
- `tests/` contains 5 tests that fail on purpose, served offline from `fixtures/`. **They only exist to exercise the pipeline. Numbers computed on them are not product metrics.**

`data/` is gitignored because the collected data stays local. Each run writes its artifacts to `test-results/<runId>/`, so attachment paths from older runs keep working.

## Rules (engine/rules.ts)

The first matching rule, in this order, decides the category. If a lower-priority rule disagrees, the confidence drops by 0.1.

| Rule | Category | Fires when |
|---|---|---|
| `env-mass-failure` | ENV | at least 3 tests, making up at least 30% of the run, fail with the **same** error shape. Many failures with different errors don't count. |
| `env-network` | ENV | the error shows a connection error (`net::ERR_*`, `ECONNREFUSED`, ...), an HTTP 5xx, or an auth failure |
| `test-data-collision` | TEST_DATA | the error shows the test's data collided with existing data (duplicate key, unique constraint, "already exists") |
| `env-server-error` | ENV | the app's backend answered a 5xx during the test; declines for tests that provoke errors on purpose, and for errors seen only on this commit |
| `locator-drift-strict` | LOCATOR_DRIFT | an action's locator now matches several elements, and exactly one of them carries the locator's name as a whole word (`name: 'Edit'` → "Editor canvas", "Edit link"). The fix is the locator Playwright printed for that element. |
| `timing-intercepted` | TIMING | the element was ready, but the error says another element (a snackbar, menu or overlay) intercepts pointer events, so the click could not land |
| `timing-retry-pass` | TIMING | another attempt of the same code in the same run passed |
| `timing-known-flaky` | TIMING | a known flaky test: in an earlier run it failed with this same error and then passed on a retry. Steps back when a request failed during the test |
| `locator-drift` | LOCATOR_DRIFT | the element was never found, but the page snapshot has an element with a similar name (similarity ≥ 0.6). Declines when the test has no recorded passing run: nothing then shows the element ever matched. |
| `timing-flaky` | TIMING | the failure rate is 20%-80% over at least 3 runs, and the error message varies |
| `real-bug-assertion` | REAL_BUG | a value mismatch on a test whose history is stable: it was clean before and has failed the same way since |

History is **point-in-time**: each failure is judged only with runs up to and including its own run, never later ones. A test's first-ever failure therefore has no history, and history-based rules decline it.

## Usage

Requires Node >= 22.18. Node runs the `.ts` scripts directly.

```bash
npm install
npx playwright install chromium

npm test              # one run (records are diagnosed as they are saved)
npm run test:loop     # 5 runs in a row, to build up history
npm run history       # failure-rate table
npm run diagnose      # rule-engine classification + coverage metric (add -- --evidence for details)
npm run eval:synthetic   # rules + LLM vs the synthetic labels (pipeline check, not a product metric)
npm run eval             # rules + LLM vs your real labels in eval/ground-truth.jsonl
npm run lab           # drift lab: the full collect -> diagnose -> decide -> auto-fix -> verify loop, locally
npm run triage        # every role's view for data/ + the phase-4 metric
npm run triage -- --data data/real/gutenberg-holdout   # the same on real CI data
npm run test:engine   # unit tests for rules, LLM layer, decide step and views (no network)
```

## Auto-fix and the drift lab (Phase 5, in progress)

`engine/autofix/` is the ACT + VERIFY loop for LOCATOR_DRIFT. It finds the failing locator in the spec, then tries up to 3 role-based replacements taken from the failure-time page. It re-runs that one test after each attempt, keeps a change only if the test passes, and otherwise restores the file. These safety rules are built into the code:

- It only edits files inside a sandbox directory, never application code.
- It refuses tests with no `expect()` after the broken call, because a pass there would prove nothing.
- It acts only on drift diagnosed by a deterministic drift rule (`locator-drift` or `locator-drift-strict`) above 0.85. On real CI data the AI alone called real bugs "drift" at 0.88–0.96, so AI-only drift goes to a person.
- Every decision is logged with its reason, and it never pushes or merges.

`npm run lab` runs the whole loop against `lab/app`. Version v1 is what the tests were written for. Version v2 is a release with 6 renamed or re-shaped elements and 5 traps: removed features with look-alike elements, a wrong price, a disabled button, a server outage, and a test without assertions. The ground truth is in `lab/cases.json`. The current result is **6/7 drifted locators fixed and verified, 0/6 false fixes**. This is synthetic data and not a product metric. On real labelled Gutenberg failures the rules now reach **15 auto-fix-eligible drift cases with 0 wrong**, each suggesting exactly the locator the developers themselves wrote.

## Learning from people (LEARN)

The agent's PR comment ends with one line telling people how to correct it. A reply like `/triage TEST_DATA #1 the fixture user has no saved card` is read on the next run, stored with the run history, and applied to every later failure of that test that fails the same way. The view then shows the category as **corrected by a person**, with their name and reason as the evidence, and keeps what the agent had said next to it, so a disagreement stays visible rather than being quietly overwritten.

Two limits are deliberate:
- A correction settles the **category**, never a code change. Someone writing `LOCATOR_DRIFT` has not given the agent a replacement locator that a re-run has proved, so an SDET still writes that fix.
- It applies to the same test failing **the same way**. A different failure of that test is a different question, and the agent answers it itself.

## What a run costs

Every triage run, the CLI, the eval and the CI job summary end with one line: how many model calls were made, how long they took, how many came free from the cache, the tokens used, and the cost when prices are configured. A run is cheap because the deterministic rules answer most failures and only what they cannot settle reaches the model. Measured example (JupyterLab, 41 real failures): the rules decided 34 of them, 6 went to the model, and those 6 calls took 30 seconds and about 31,000 tokens in total.

## Security

The agent reads text that a pull request's author controls (test names, error messages, traces) and it can change what blocks a merge, so it is built for untrusted input:

- **Corrections come only from people with write access** (owner, member or collaborator). On a public repository a stranger's `/triage` comment is ignored, so nobody outside the team can wave a real failure past the merge gate.
- **Only the agent's own comment defines what `#1` means.** A numbering map posted by anyone else is ignored, and the map's fields are encoded so no test name can break out of it.
- **Text from a test run is made inert in comments:** `@mentions` do not notify anyone, links and images show as plain text, and HTML is escaped.
- **The AI never has the last word on anything risky.** A crafted error message could try to talk the model into an answer, but AI-only verdicts never let a failure through the gate and never authorise a code change; fixes need a deterministic rule's match and a passing re-run.
- **It never merges, never edits application code**, and keeps collected data in the Actions cache, not in the repository. The OpenAI key is optional and only ever read from a secret.

## Known issues (found on real data)

- **Drift and real bugs are hard to tell apart (improving).** Rules-5 reads Playwright's strict-mode errors: when a locator like `name: 'Edit'` starts matching several elements, the error already lists them, and the one named with the whole word is the element the test means. On the fresh set (Sep 1–3) drift is **16/20 = 80%** (**16/23 = 70%** on the labels before a labelling flaw was corrected, see [eval/README.md](eval/README.md)), real bugs called drift **1 of 29**, and **15 drift cases would now be auto-fixed, each suggestion identical to the developers' own fix**. On an unseen week (Aug 20–26, 473 labels) drift is **3/3** and the agent would still have made **0 automatic changes**. The remaining misses have no usable page data: the error names no locator at all.
- **Playwright does not always write a page snapshot.** For some failures (timeouts inside frames) `error-context.md` holds only the error and the test source, so the similarity rule is blind. Rebuilding the page from the trace DOM does not help: on real data, real bugs score as similar as drift (0.80–0.96), so it gives the AI noise rather than signal (it lowered held-out accuracy from 86.1% to 81.3% when tried).
- **Expected server errors (partly fixed).** Tests that deliberately provoke server errors used to be read as ENV. The model is now told when a test's name says it exercises error handling (prompt llm-4).
- **Views can't tell pull-request branches from the main branch yet.** Records don't store the branch, so regressions inside unmerged PRs count as product bugs in the architecture view and the digest.
- **Some recurring flakes are misread.** Flaky tests that also fail on other branches are misclassified (0/22 on the held-out set), and TEST_DATA and LOCATOR_DRIFT are not yet measured on real data.

Environment variables (you can put them in `.env`, which is gitignored):

- `OPENAI_API_KEY`: turns the LLM layer on. Without it, only the rules run.
- `TRIAGE_LLM=off`: turns the LLM layer off even when a key is set.
- `TRIAGE_LLM_MODEL` (default `gpt-5.4-mini`) and `TRIAGE_LLM_REASONING` (default `low`): choose the model and its reasoning effort.
- `TRIAGE_LLM_CACHE=off`: skips the response cache in `data/llm-cache.jsonl`. With the cache on, an unchanged request is answered from the cache for free.
- `TRIAGE_LLM_MAX_CALLS`: at most this many model calls per run. Further failures keep the rules' answer and say so, instead of running up an unbounded bill on a huge failed run.
- `TRIAGE_LLM_PRICE_IN` / `TRIAGE_LLM_PRICE_OUT`: your price per million input / output tokens. Set them and every run prints what it cost; leave them unset and it prints tokens only, never a guessed price.
- `CI_RUN_ID`: used as the run id. If it is not set, the run id is based on a timestamp.
- `GIT_SHA` or `GITHUB_SHA`: stored as the record's `gitSha`. If neither is set, `gitSha` is left empty.

**Data leaving the machine:** with the LLM layer on, the summary of each UNKNOWN failure is sent to OpenAI. That summary includes the error text, the page snapshot, failed request URLs (without query strings) and console errors. Nothing is committed to git.
