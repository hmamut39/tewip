# Tewip

**Tewip** (Uyghur *téwip*, تېۋىپ: healer, doctor) is the layer that **proves software work** - written by a person or by an agent.

It finds why each failing test failed (a real bug, a flaky test, the environment, test data, or a changed selector), says whether a test could ever fail at all, breaks your code to find out whether the tests would notice, reads what a migration will do to a live database, and gives one verdict on whether a change is done. Every answer carries its evidence and names what decided it: a deterministic rule, the AI model, or a person's correction.

What makes it worth installing is what it refuses to say. It answers *"cannot say"* rather than guessing, it will not narrow a test run it cannot prove safe to narrow, and every report ends with what it did **not** check. Each number below was measured on strangers' real code, never on fixtures.

It works for every stack: Node.js (node:test, Jest, Vitest, Mocha), Python (pytest, unittest), Java and Kotlin (JUnit, TestNG), Go, .NET, Ruby, PHP and Rust, each checked against its real runner's report ([the full list](QUICKSTART.md#not-using-playwright-every-stack-works)), plus Playwright in depth with traces, selector drift and verified fixes. It also reads the failure wording of the browser and component-test tools on top of those runners (Selenium, WebdriverIO, Cypress, Testing Library for React, Vue and Angular, Vue Test Utils, jest-dom and Jasmine), checked against more than 500 real messages from public projects.

| Where | How |
|---|---|
| **Terminal** | `npm install -g tewip-ai`, then `tewip explain report.xml`, `tewip ci owner/repo --pr 12`, `tewip mcp` |
| **VS Code, Cursor, Windsurf, VSCodium** | the Tewip extension ([download](https://github.com/hmamut39/tewip/releases/tag/vscode-0.5.0)): registers Tewip with the editor's AI assistant and adds six commands - explain a report, why CI failed on this branch, the risk review of your change, which flaky tests to quarantine, the security check, and what your corrections add up to |
| **JetBrains, Claude, other AI assistants** | add the MCP server `tewip mcp`: fifteen tools, including *has this happened here before?*, *is this requirement covered and passing?* and *what should be done next about this goal?* (see [editor setup](#use-it-from-your-editor-any-ide-that-speaks-mcp)) |
| **Any model** | OpenAI, Claude, Gemini, Azure, or a model on your own machine with Ollama (no account, nothing leaves the computer): `TEWIP_PROVIDER` |
| **GitHub CI** | the Tewip Action: a comment on every pull request, an optional merge gate, verified fix PRs ([QUICKSTART](QUICKSTART.md)) |

Formerly *triage-agent*: the repository moved to `hmamut39/tewip`, and GitHub redirects the old address. See [ROADMAP.md](ROADMAP.md) for the plan.

**Status: phases 1 to 14 are built; the two auto-fix phases (5 and 8) are the ones still in progress.** Tewip collects failures from any framework, diagnoses them with rules first and a model only for what rules cannot settle, and turns that into work for each role: a CI comment and merge gate, test plans and verified tests, a flake dossier, a PR-risk review, security scanning, tickets in Jira, Rally, GitHub Issues, Azure Boards or Linear, checks generated from a Figma design, specifications written for people, and - opt in, and only when proved - fixes to test or application code. It runs live in GitHub CI and answers questions from AI assistants through MCP. On fresh real Gutenberg CI failures, with the pipeline frozen before labelling, accuracy is 93.4%; across six real datasets it ranges from 86.1% to 99.7%, and the caveats are in [eval/README.md](eval/README.md).

## What it costs

Most failures never reach a model. On 3,556 real CI failures from six public projects, the
deterministic rules answered **75.1%** on their own - and on the labelled ones they answered
correctly **1,979 times out of 2,012 (98.4%)**. A rule-answered failure costs nothing, explains
itself, and gives the same answer every time.

Only the remaining quarter is sent to a model, so triaging **1,000 real failures costs about
$1.12** at gpt-5.4-mini's published price. That is measured, not estimated: three real uncached
calls on held-out failures billed 3,624 prompt and 499 completion tokens each. A real week costs
less, because a failure that repeats is answered from cache, and a failure someone has corrected
never goes to the model again.

Tewip prints what every command costs, caps its own spend, and works with no key at all - the rules
run on their own and everything they cannot settle is left as UNKNOWN rather than guessed.

## Use it in your project

**Giving it to your team (or another company): [TEAM-GUIDE.md](TEAM-GUIDE.md)** — what to install, what each role uses it for, and what it never does.

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
  actions: read          # lets it read the failed job's log when no test report was written

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
- **The tests in the pull request:** on a PR it reads the test files the change touched and says which
  of them could never fail - an unfinished expectation, a value compared with itself, a test that
  discards its own failure, one that never runs. It says nothing when they are all sound, and it says
  it **even on a green run**, because "all tests passed" is the exact sentence that needs qualifying
  when one of them cannot fail. Needs `fetch-depth: 0` on `actions/checkout` so the diff can be read;
  without it the section is skipped rather than guessed at. Any such test also enters the attestation
  as a refusal, so a release decision taken from the bundle cannot rest on a test that proves nothing.
- **What the change would slip past (`prove: true`):** breaks the source files the pull request touched
  in small deliberate ways, runs the tests that cover them, and reports every change none of them
  noticed - "these 2 changes to your code would have slipped past your tests", with the lines. Off by
  default because each change costs a real test run; `prove-budget` (default 300s) caps the whole
  thing, and it says which files it did not reach rather than implying they were clean. Every file is
  put back exactly as it was. Each unnoticed change also enters the attestation as a refusal: a line
  nothing checks is not a line this bundle can claim was verified.
- **Evidence, every run:** the Action writes an attestation into its artifact - the claims with
  their evidence and which layer decided each, what Tewip **refused** to decide, and what it did
  not check at all. Nothing enters it that Tewip did not verify itself, so a release decision can
  be taken from it without opening CI.
- **Fixes (`autofix: true`):** for drifted locators that the deterministic rule matched to a renamed element, it rewrites the locator, re-runs that test, and opens a separate pull request with the changes that passed. It never merges and never edits application code.
- **Every role:** uploads all role views as the `tewip-report` artifact.
- **When the job dies before any test runs** (an image that would not pull, a runner out of disk, a service container that never came up): it reads the failed job's log and names the cause, instead of leaving a red X with no explanation.
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

The repository needs "Allow GitHub Actions to create and approve pull requests" enabled for fix PRs. Pull requests opened by the workflow token don't trigger CI themselves; the agent verified each change by re-running the test before opening the PR. It was first proved end to end on a private practice repository, which is why there is no link to click here. If this repository is private, other repositories can only use the action when Settings → Actions → Access allows it.

### As a Claude Code plugin (no account, no marketplace approval)

```bash
claude plugin marketplace add hmamut39/tewip-plugin
claude plugin install tewip@tewip
```

That is the whole publication process. A marketplace is a `.claude-plugin/marketplace.json` file in a git
repository, so Tewip publishes one at
[hmamut39/tewip-plugin](https://github.com/hmamut39/tewip-plugin) - nobody has to approve it, and there
is nothing to pay for. That repository holds the plugin only: a manifest, three skills and a pointer to
the npm package, which is why this one can stay private. The plugin brings Tewip's MCP server and three skills that tell Claude Code *when* to use it:
before claiming a change is done, when a test fails, and when a change touches a migration. It costs
about 410 tokens per session until a skill is actually needed.

The MCP server runs from the published package (`npx -y tewip-ai@latest mcp`), so the plugin stays small
and you always get the current version.

### The editor extension (VS Code, Cursor, Windsurf, VSCodium)

**Open the Extensions pane and search for "Tewip".** It is in both registries, so that works in
VS Code, Cursor, Windsurf, VSCodium, Gitpod and Eclipse Theia:

- **VS Code** — [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=hmamut39.tewip)
- **Cursor, Windsurf, VSCodium, Gitpod, Theia** — [Open VSX](https://open-vsx.org/extension/hmamut39/tewip)

Or install the `.vsix` attached to any [release](https://github.com/hmamut39/tewip/releases) with
**Extensions: Install from VSIX…**. Either way it needs the command line: `npm install -g tewip-ai`.

Press `Ctrl+Shift+P` and type "Tewip" for: *Is this work done?*, *Can everybody use this?*, *Could
these tests ever fail?*, *Would the tests catch a bug in this file?*, *Which tests could notice this
change?*, *What will this migration do to a live database?*, *Why did CI fail on this branch?*, and
more. The editor's AI assistant also picks Tewip up as an MCP server with nothing to configure.

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
| "Write a test plan for the checkout feature in C:\work\shop" | `test_plan`: risks and scenarios grounded in that project's tests, code and pages; saved in its `.tewip` folder |

Setup, after `npm install`:

- **Claude Code** in this repo: [.mcp.json](.mcp.json) is already here, so approve `tewip` when asked. From anywhere else, run `claude mcp add tewip -- tewip mcp` (installed), or `claude mcp add tewip -- node /path/to/tewip/mcp/server.ts` (from a checkout).
- **Claude Desktop, Cursor, VS Code, and other MCP clients:** add a stdio server with command `tewip` and args `["mcp"]`, or command `node` with args `["/path/to/tewip/mcp/server.ts"]` from a checkout.

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

Then ask, in plain language: *"why did CI fail on my PR?"*, *"which tests are flaky in checkout?"*, *"is the main branch safe to release?"*. You can also ask it to *"write a test plan for the checkout feature in C:\work\shop"*: the `test_plan` tool plans from that project's real tests, code and pages, and saves the plan in its `.tewip` folder. Every other tool is read-only, and `github_ci_report` reads the report the Action uploaded, so you can ask about a repository's CI **without cloning it or opening the Actions page** (it uses your `gh` login).

## Plan and write tests (Phases 6 and 7, new)

Run these inside your project. Both need `OPENAI_API_KEY`, and both print what they cost.

```bash
tewip plan "Checkout: a signed-in shopper pays by card and gets a receipt" --url http://localhost:3000/checkout
tewip write                        # tests for the plan's "to automate next" scenarios
tewip write --only CO-002,CO-004 --framework pytest
```

- **`tewip plan`** reads what is really there: the tests you already have (in any language), the change (`--diff main...HEAD`), the live pages (what a user sees on each page, via Playwright), and the failures Tewip has diagnosed in this project before. The plan lists risks and scenarios by priority. A claim that a scenario is "already covered" is checked against your real test names, and dropped if no such test exists. Saved to `.tewip/plans/` as Markdown to review and JSON for `write`.
- **Does a plan catch real bugs?** Measured on 18 real pull requests that were later found to have
  broken something: the repository is fetched at the pull request's own head, the plan written from
  the diff a reviewer saw, and nothing about the bug is known to it. **In 8 of the 9 pairs that
  could be judged, a scenario named the bug** - in `matrix-org/complement`, `NLnetLabs/domain`,
  `Bioconductor/rhdf5`, `Try/OpenGothic` and others. One pull request was titled "Resolve nightly
  warnings" and the plan still found the behaviour change hidden inside it. The caveats are real
  and written out in [ROADMAP.md](ROADMAP.md): nine judged pairs is a small sample, Claude did the
  judging rather than each project's engineers, and the one miss is the interesting case - when a
  pull request's *intention* is wrong, a plan grounded in that intention agrees with it.
- **`tewip write`** writes each scenario as a test in **your** framework and style: Playwright, Cypress, WebdriverIO, Angular, Jest, Vitest, pytest (with Selenium or Playwright), JUnit on Maven or Gradle (Selenium, Spring Boot), .NET or Go. It copies the style of an existing test and uses only elements seen on the real page. Front-end apps get component tests the way their own tests are written: React, Vue or Svelte with Testing Library under Jest or Vitest, and Angular through `ng test` (Karma and Jasmine, or Vitest). A project with both e2e and unit tests gets browser tests when the plan read pages, and unit or component tests when it did not. Then it runs the test. A draft is **kept only if** it passes every run (3 by default) **and** fails once its main check is broken on purpose, because a test that cannot fail is worse than no test. A failing draft is repaired from the real error, twice at most. If the test looks right and the app does something else, Tewip reports a **possible bug** instead of weakening the test until it passes. Kept tests are new files beside yours, for you to review and commit; nothing is committed, and no application code is touched.

## Check the page against the design (Phase 11, new)

```bash
tewip design "https://www.figma.com/design/KEY/Checkout?node-id=12-34" --url http://localhost:3000/checkout
tewip design frame.json --frame "Sign in"     # a saved frame, no Figma token needed
```

Tewip reads the frame (Figma's REST API, read only, `TEWIP_FIGMA_TOKEN`) and the running page
(its accessibility snapshot, which is what a screen reader and a test both see), and says where they
disagree: `the design says button "Sign in", the page says button "Log in"`. It checks the words the
design specifies, the controls its layer names imply, and the regions its sections imply - never
pixels, colours or spacing, because a design tool and a browser do not measure those the same way.
No model is called, so it costs nothing and answers the same way every time.

Measured on four real design/page pairs (a public repository's Figma exports and the pages built
from them): 38 checks, **0 differences reported on pages that match their design**, **11 of 11 real
drifts caught** (a renamed control, a dropped sentence, a word swapped inside a sentence, a region
that lost its markup) and **5 of 5 harmless changes ignored** (capitals, extra spaces, a button
implemented as a link, reordered sections). No designer has judged the output yet, so the roadmap's
own metric is still open.

## More runners: Robot Framework, JMeter, k6 (new)

Tewip now reads **Robot Framework's output.xml**, **JMeter's .jtl** and a **k6 summary** as well as
JUnit XML, TRX, NUnit and Playwright's own reports. A load test does not fail test by test, so a
JMeter report becomes one line per request ("4 of 5 requests failed, an assertion failed") and a k6
run becomes one record per crossed threshold, with the number that crossed it.

Appium and Selenium need no importer: those suites report through Mocha, pytest or JUnit, which
Tewip already reads, and their own error messages ("Could not find a connected device", "stale
element reference") are already understood.

Each reader was checked against real reports published in public repositories, which is how three
defects were found before release - a Robot timestamp that is not a date, k6's numbers living under
`values`, and a JMeter line that read "mostly 200" when an assertion had failed.

## Tell it when it is wrong (new)

```bash
tewip correct diagnosis "checkout charges twice" TEST_DATA "the fixture has stale prices"
tewip correct flaky "adds an item" fix-now "it is a real race, not flakiness"
tewip correct security "src/config.ts:12" noise "that is a sample key in a fixture"
tewip correct --list
```

Tewip answers with **your** decision from then on, and says it was yours: *"TEST_DATA, confidence
1.00, source: corrected by a person"*. Corrections live in your project, so they belong to the team;
the newest one wins, so changing your mind is just saying so again.

**A correction changes what Tewip says, never what it does on its own** — it will not change code,
quarantine a test or file a ticket because you corrected it.

## What your corrections add up to (new)

```bash
tewip learn                      # where Tewip is systematically wrong, from what you corrected
tewip learn --labels labels.jsonl  # your corrections as labelled examples, to measure a change against
```

One correction fixes one failure. Twenty of them say which rule to change. `tewip learn` groups
them - "45x said REAL_BUG, you said TIMING; rule `locator-drift` decided 27 of them; from 11
different tests" - and points at the rule to read, with three of the real failures underneath.

It will not pretend. Fewer than three corrections of the same shape is "not yet a pattern", not a
finding; when no single rule is behind a group it says a rule is *missing* rather than blaming one;
and it tells you how many different tests a pattern came from, because one flaky test corrected six
times is one piece of evidence, not six.

## Build a feature, test first (new)

```bash
tewip build "naturalsize should take a sep argument that goes between the number and the unit"
tewip build --issue PROJ-123    # build from the ticket's own description and acceptance criteria
tewip build "..." --pr          # commit the proved work on its own branch, open a draft PR
tewip build "..." --dry-run     # prove it, show the patch, leave nothing on disk
```

Tewip writes the **test first** and runs it. **If that test passes, it stops and keeps nothing** —
a test that passes before the feature exists is testing nothing. Then it writes the smallest code
that makes the test pass, and keeps the work only if the new test passes *and* nothing that was
passing has started to fail. Otherwise every file goes back byte for byte, including the test it
wrote. Nothing is ever committed.

Tried on two real public projects: it added a trailing-slash rule to **unjs/ufo** (4 lines,
TypeScript, $0.18) and a `sep` argument to **python-humanize** (2 lines, Python, $0.10), each with
its own failing-then-passing test and the project's whole suite still green. Asked for something
that already worked, it stopped after one model call and kept nothing.

It also refuses a feature that does not belong here at all. Handed a real Apache ticket about a
Flink HTTP sink, a URL library got an "HTTP sink" built into it - test passing, suite green, every
proof rule held, because when Tewip writes *both* the test and the code it can always make a
self-consistent pair pass. So before writing anything it now asks whether the words of the feature
mean anything in this repository, and refuses for free when they do not.

The old promise was *"it can't touch your code"*. The new one is *"it can't change your code without
showing you it works"*.

## Before anyone reads the diff (new)

```bash
tewip review --diff main...HEAD
```

Which tests cover this change and **how** (they import the file, they import the package that
exports it, or their words merely match); which of them have flaked before, so a red run is not
blamed on your change; what has gone wrong in these areas before; what nothing tests at all; and the
command to run the telling tests first. From your project's own history, so it costs nothing.

Measured on **16 real commits** from two public projects, where the developers changed source *and*
its test: given only the source files, Tewip **named the right test in 16 of 16, ranked it first in
12**.

It also shows **the checks a change renegotiates** — every test assertion the diff rewrites,
withdraws or renames, with the old text beside the new one. A test written earlier is behaviour
someone agreed on, and this is the one thing in a review that the change's own description cannot
account for: everything else reads the change's account of itself. It never passes judgement — tests
change for good reasons — it asks which of them the author intended.

Alongside it, **the decisions a change alters outside its tests**: a guard that refused something,
a value other code falls back on, a limit that decides behaviour under load, a version or runner
pinned on purpose. Same rule - only things that already existed, never additions - and the same
question rather than a verdict.

Both came out of a measurement rather than an idea. Of 18 real pull requests later found to have
broken something, the one Tewip's test plan missed was one whose *intention* was wrong: it changed
a freshness rule, changed the tests to match, and was reverted the next day.

**What these checks are not is a predictor**, and the measurement says so plainly. On 14 pull
requests known to have caused a regression they speak up on 4; on 30 ordinary merged pull requests
from the same repositories, on 9 - 29% against 30%. A change that alters an agreement is not more
likely to be broken. What they do is put those alterations in front of a person: on the ordinary
set they surfaced 23 of them, among which a `raise SystemExit` guard that was deleted, a semaphore
dropped from 4 to 1, and a CI runner image moved. No model is called, so this costs nothing.

## Which flaky tests to quarantine, and what they cost (new)

```bash
tewip flaky --days 30        # the dossier: quarantine, fix, or watch - with the evidence
tewip flaky --apply          # writes the quarantine line into the test file
```

Other tools count retries. Tewip already decided *why* each failure happened, so it can say: this
test failed in 161 of 647 runs **across 109 different branches** - that is the test, not your
change - and quarantining it gives the team back 148 CI minutes a week. It refuses to hide a test
that mostly fails (that one is broken, not flaky) and **never** quarantines a test whose failures
looked like a real bug.

Measured on three real projects' CI history (Gutenberg twice, Supabase): 76 tests proposed for
quarantine, **zero of them containing a single real-bug failure**, giving back roughly 34, 148 and
1,178 CI minutes a week. It also tells you when a quarantined test has stopped failing and should
come back - the half nobody ever does.

## Bugs filed back, and test cases where your team keeps them (Phase 10, completed)

```bash
tewip bugs report.xml --project SHOP             # shows what it would file; nothing is created
tewip bugs report.xml --project SHOP --create    # files them
tewip jira plan.json --export xray --out cases.csv    # or --export zephyr
```

`tewip bugs` files a ticket only for failures **it** diagnosed as a real bug, with the error, the
evidence and the run link. A flaky test or a broken environment is deliberately not filed - that is
the point of diagnosing first. The same failure is never filed twice: the second sighting is a short
note on the ticket Tewip itself opened. A dry run needs no Jira account at all.

`--export xray|zephyr` writes the plan's scenarios as the CSV those tools import, one row per step.
No account, no network; importing stays your step.

## Security: which findings actually matter (Phase 9, new)

```bash
tewip secure                              # secrets + npm audit / pip-audit / osv-scanner, triaged
tewip secure --url http://localhost:3000  # also check the running app
tewip secure --zap-report zap.json        # and triage an OWASP ZAP baseline report
tewip secure --gate                       # fails a build only on what needs a person now
```

Scanners are good at finding things and bad at saying which of them matter. Tewip runs the ones your
project already has and sorts every finding into **act on this now**, **real but not reachable**
(a dev dependency, a package nothing imports, a file git does not track), **noise** (a placeholder
from a README), or **accepted** (a person already judged it, in a file only people write). Each
verdict carries the evidence. No model is called, so it costs nothing, and **a credential is
located, never printed**.

With `--url` it also checks the running app the way a browser would: security headers, cookie
flags, and the files that must never be served (.env, .git). No payloads, no fuzzing, no login
bypass - and **an address that is not your machine is refused** unless you say `--i-am-authorised`.
For the deep scan it prints the OWASP ZAP command and triages ZAP's report rather than pretending
to be a scanner.

Measured on the gitleaks project's own labelled samples, for the credential kinds Tewip covers:
**50 of 54 real credentials found**. The web check found **8 of 8 planted weaknesses** in two local
apps and reported **nothing** about the carefully served one; on four real public homepages its
report matched the headers those sites actually send, every time. Four defects that corpus exposed are fixed; the four still
missed are things that are not credentials (an unsigned token, a Stripe *test* key). It never claims
a project is secure - it prints what it checked and what it did not.

## Epics, stories and acceptance criteria (Phase 14, new)

```bash
tewip spec "Readers can search the library and open a result"
tewip spec "..." --project PROJ            # shows what it would file in Jira
tewip spec "..." --project PROJ --create   # files the epic and its stories
```

An epic, user stories and Given / When / Then acceptance criteria, written from your code, your
tests and your failure history. Anything it says the system **already** does carries a quote from a
file it read, and Tewip checks that quote word by word; what it cannot quote becomes an open
question instead of a confident sentence. It writes no estimates, dates or business cases, because
it cannot check them.

Measured on three real projects: 15 stories, 49 acceptance criteria, and of 46 claims about existing
behaviour, **22 were kept with a checkable quote and 24 were turned into open questions**.

## Any CI, your chat, and your own machine (Phase 13, new)

```bash
tewip report report.xml --gate      # GitLab CI, Jenkins, CircleCI, Azure, Bitbucket, Travis, Drone
tewip watch --cmd "npm test"        # beside your editor: explains each failure as it happens
tewip note --days 7                 # the weekly quality note for a lead - free, no model calls
```

`tewip report` reads which CI it is in from that platform's own variables, prints the triage board,
writes it to a file, appends it to the job summary, and with `--gate` fails the build **only** on
failures that are not known flaky or environment noise. On GitLab it posts the diagnosis as one
merge-request note and edits that same note next run instead of piling up. With
`TEWIP_SLACK_WEBHOOK` or `TEWIP_TEAMS_WEBHOOK` it tells the team's chat - and says nothing at all
when no failure needs a person, so nobody mutes it.

## Fix the code, but only when the tests prove it (Phase 12, new, opt-in)

```bash
tewip fix --code report.xml          # shows the patch; your files are left as they were
tewip fix --code report.xml --apply  # leaves the proved change in your working tree
```

Tewip has refused to touch application code since day one. This is the one exception, and it only
runs when you type `--code`. It takes a failure **it** diagnosed as a real bug (0.85 confidence or
more), finds the file the failure points at, asks for the smallest change, and then proves it: the
failing test must pass **and** the whole suite must still pass. It will not edit tests,
configuration, CI files, lockfiles, migrations or anything with secrets in it, because a test going
green after changing those proves nothing. If it cannot prove a change, it explains the bug instead
and puts your file back byte for byte. It never commits and never merges.

Measured by replaying **16 real bug fixes** from two public repositories, in two languages: the
commit before each fix, with only that fix's tests, so the real bug really reproduces.

| Project | Language | Bugs | Proved by the tests | Right file |
|---|---|---|---|---|
| unjs/ufo | TypeScript, Vitest | 8 | **8** | 8 of 8 |
| python-humanize/humanize | Python, pytest | 8 | **8** | 8 of 8 |

Every change is small (1 to 16 lines, median 4) and most are what the developers themselves wrote.
**No wrong fix was offered**: anything that could not be proved was thrown away and the file put
back byte for byte.

## One bundle a release manager can read (Phase 15)

```bash
tewip attest --out attestation.md
```

Everything Tewip knows about a build, in one file: which tests ran, what each failure was, which
rule or which model decided it, **what it refused to decide**, and what it never looked at. The
refusals are the point - a tool that never says "I could not tell" has nothing worth attesting,
because every line it writes might be a guess.

The bundle carries a digest, and an Ed25519 signature when you give it a key:

```bash
TEWIP_ATTEST_KEY=./private.pem tewip attest            # sign it
tewip attest --verify attestation.json --key public.pem  # check it
```

A digest is not a signature and Tewip says so: without a key it tells you the bundle is undamaged,
not that nobody edited it. Editing a claim out of a signed bundle makes verification fail and exit
non-zero. Every CI run writes one of these automatically.

## Is this incident covered by a test? (Phase 16)

```bash
tewip incident sentry-issue.json
```

Reads a Sentry payload, an OpenTelemetry span or a plain stack trace, finds the test that should
have caught it, and answers with one of four verdicts: **reproduced**, **passed** (the test ran and
did not catch it, which is worse news), **failed differently**, or **never ran**. It does not say
"probably covered".

## What did we decide about this last time? (Phase 17)

```bash
tewip recall "the login test that keeps flaking"
```

Every correction your team ever gave Tewip is kept. Ask, and it answers with your own decision from
then, and says it was yours - not its. It never acts on a correction by itself.

## From the ticket to the run (Phase 18)

```bash
tewip trace --only "SHOP-12"
```

Joins the test plans Tewip wrote to the tests that cover them and the runs that attempted them. A
scenario counts as covered only when a real test can be named, and passing only when a real run
attempted it; everything else says what is missing. No model, no cost.

## Is this work actually done? (Phase 24)

```bash
tewip done --diff main...HEAD            # one verdict
tewip done --prove --strict              # also break the code, and fail the build unless ready
tewip done --json done.json              # a sealed verdict that can be checked later
```

Tewip can answer six questions about a change. A team reviewing an agent's pull request has to run six
commands and assemble the answer themselves - which in practice means they run none and merge on a
green tick. `done` is the assembled answer:

```
# Is this work done? Not ready

| Question                                   | Answer      |
| Is anything failing?                       | not checked |
| Is the changed code tested?                | yes         |
| Can the tests in this change fail?         | no          |
| Would the tests catch a bug in this code?  | no          |
| Is what was asked for covered?             | not checked |
```

That is a real run on a change where **all three tests passed**. One of them was `assert.ok(true)`, and
three deliberate changes to the new code went unnoticed by the suite. CI was green; the work was not
done.

Nothing is judged here. Every answer comes from a layer with its own measured accuracy — the triage
rules, `vouch`, `prove`, `trace` — and this only puts them in a fixed, published order: what is broken,
then what cannot be believed, then what is missing. The same change always gets the same verdict.

**"Cannot say" is a real answer, and it is never rounded up to ready.** A verdict needs the two questions
nothing can substitute for — is anything failing, and does anything actually test this code — to have
been answered. If Tewip has never seen a test result for the project, it says so and refuses to approve;
the first version of this answered "Ready, with 3 not checked", which is an approval assembled out of
shrugs. Every verdict also ends with what it says nothing about, including the one thing no tool here
can know: whether the change does what was intended.

With `--json` the verdict is **sealed**: editing `not-ready` to `ready` in the file makes verification
fail, so a verdict that travels into a ticket or a release note can be checked rather than trusted. It is
also an MCP tool, so an agent can ask whether its own work is done before saying that it is.

## Is this change slower? (Phase 30, new)

```bash
tewip perf summary.json --record            # on main: add this run to the baseline
tewip perf summary.json --strict            # on a branch: fail the build on a real regression
```

Tewip has imported k6 results for a while and never had an opinion about them. Now it answers the
question every team asks before a release.

**The hard part is not the arithmetic.** "p95 went from 180ms to 210ms, +16%" is four lines of code
and worthless, because nobody knows whether 16% is the change or the laptop. Here are **four real k6
runs of code that did not change**:

```
run 1   p95 = 60.9ms
run 2   p95 = 60.8ms
run 3   p95 = 62.8ms
run 4   p95 = 61.4ms
```

A 3% spread from nothing at all. A tool that calls that a regression gets switched off.

So Tewip answers **two questions separately**, because they fail separately:

| | |
|---|---|
| **Did your own thresholds hold?** | You already wrote what "fast enough" means in your k6 script. Tewip reads the result instead of asking you to write a budget twice. |
| **Is it slower than it was?** | Answered **only** from three or more recorded baselines. Below that: *cannot say*. |

Given those three real baselines, a fourth identical run at 61.4ms is **not** called a regression —
and a genuine one is:

```
- `http_req_duration` p95 282.5ms — **slower**
  - baseline 60.8ms–62.8ms over 3 runs, middle 60.9ms
  - 282.5ms is outside everything 3 baseline runs produced (60.8-62.8ms) by more than
    their own spread, so the runs cannot explain it. That is +364% on the middle run.
```

**Recording is deliberately not automatic.** A tool that files every run into the baseline ratchets:
today's regression becomes tomorrow's normal, the comparison keeps saying "within range", and a
service triples in latency over a quarter without one report ever being wrong. `--record` on main,
compare everywhere else.

**It never predicts a duration, a capacity, or what a user will feel.** It cannot see your production
hardware, your real data volume or your real traffic, and every report says so.

### Lighthouse too (Phase 31, new)

```bash
tewip perf lighthouse-report.json --record
```

k6 measures what your server does under load. Lighthouse measures what **one page load costs in a real
browser** — Largest Contentful Paint, layout shift, blocking time — which is nearer to what a person
actually waits for. `tewip perf` takes either and works out which it was given.

Lighthouse needs the same discipline *more*, not less. **Four real Lighthouse runs of an unchanged
page gave LCP of 922, 912, 936 and 916ms.** Same rule: three baselines, outside the range by more than
its own width.

**And Tewip does not invent a verdict.** "Is 2112ms bad?" has a published answer and it is Google's:
Lighthouse scores every metric on its own curve. Tewip reads that score rather than hard-coding
thresholds it remembered — which matters, because on the real slowed run FCP and LCP had the *identical*
value of 2112ms and Lighthouse rates them differently:

```
- good — `largest-contentful-paint`: 2112ms
- needs improvement — `first-contentful-paint`: 2112ms
- **poor** — `server-response-time`: 611ms
```

One remembered threshold applied to both would have been wrong.

It also surfaces the **ten accessibility audits Lighthouse refuses to score** — logical tab order, focus
traps, whether visual order follows the DOM. Those are neither failures nor passes, and a page with no
failures and ten unanswered manual checks is not a page that passed.

One more thing it refuses: if your summary came from `--new-machine-readable-summary`, that export
records **no threshold results at all** — the word appears in it only inside a copy of your script.
Tewip says "this export cannot tell me" rather than "nothing was breached".

## Can everybody use it? (Phase 28, new)

```bash
tewip access                           # every markup file in the project
tewip access src/components/Nav.tsx    # or just one
tewip access --strict                  # fails the build on a barrier that stops somebody outright
```

Accessibility is the one quality question that is also a legal one. The European Accessibility Act has
been enforceable since June 2025, and it lands on the people who already own testing.

The reason teams do not trust the tools they have is the reason they switch off every scanner: axe,
Lighthouse and pa11y hand back several hundred undifferentiated violations, a large share of which are
not barriers at all, and nobody has the afternoon it takes to sort them.

Tewip makes **two kinds of statement and no third**:

- **a barrier** — the element as written stops somebody, and reading it is enough to know that;
- **a question** — something here is missing or unreadable, and only you can settle it.

There is no "warning", because a warning is the category people learn to scroll past.

```
**6 barriers (5 that stop somebody outright), 18 for a person to settle.**

### button-name - 3 places

WCAG 2.2 4.1.2 Name, Role, Value (A), blocker.

Who it stops: a screen reader announces "button" and nothing else, so it cannot be used or spoken to.

- `components/VPNavBarAskAiButton.vue:2`  <button type="button" class="VPNavBarAskAiButton">
  - it contains no text and carries no aria-label, so it is announced with its role and nothing else
  - do this: put text inside it, or add aria-label="..." saying what it does
```

Every finding names its **WCAG 2.2 success criterion and level**, which is what turns it into something
you can put in front of a regulator instead of a note saying "bad contrast".

**What it refuses to decide is the reason it is worth running.** `alt={caption}` is not a missing alt.
A button whose text comes from a child component cannot be called empty. `:aria-label="label"` is a
label. `<slot />` is content this file cannot see. Each of those becomes a question, never an accusation
— because a tool that accuses `<img alt={alt} />` of having no alt text gets switched off in a day.

**And every report prints what it did not check** — contrast, focus order, meaningful sequence, whether
the alt text is any good — because those need a rendered page. A clean result means these checks found
nothing. It never means the product is accessible.

No browser, no server, no network, no model, no cost. 416 real files in 1.65 seconds.

Measured on four public projects, never on fixtures — excalidraw, bootstrap, vitepress and svelte:
**50 barriers, 29 of them the kind that stop somebody outright, and 90 questions.** Seven false-positive
classes were found and fixed along the way, every one of them a defect in Tewip rather than in the
projects, and none of them reachable from a fixture. They are listed in [ROADMAP.md](ROADMAP.md).

### Already run axe? Give Tewip the JSON (Phase 29, new)

```bash
tewip access --report axe-results.json
```

Reading markup cannot see contrast. A browser can, so if your Playwright, Cypress or jest-axe suite
already writes an axe report, hand it over — and Tewip will triage it instead of relaying it.

This is where the numbers get uncomfortable. axe 4.14 over nine real pages returned **174 findings**:

| | |
|---|---|
| **53 barriers** | a real WCAG criterion, with the **EN 301 549** clause the EU Accessibility Act cites |
| **51 advice** | axe rules tagged `best-practice` that map to **no criterion at all** |
| **70 questions** | axe's own `incomplete` — it could not determine them |

**42% of what axe hands you tests no standard.** `region` alone — "all content should be contained by
landmarks" — was 40 findings, outnumbering every real barrier on the page. Tewip reports those as advice,
never as barriers, and they never fail a build. That separation is most of the point.

And the unchecked list shrinks, honestly: **one** of its seven entries — 1.4.3 Contrast — moves to
checked. The other six stay, because no tool settles them. The report also names how many pages the run
covered, and says plainly that nothing is known about a page it did not open or a state it did not reach.

```
## Checked here only because a browser run was given

- **1.4.3 Contrast (Minimum)** - would otherwise be unreachable: needs the computed colours of a
  rendered page, not the markup
```

A source finding is set aside only when the run opened **that same file** and re-ran the equivalent rule.
In a React or Vue project that means nothing is set aside — the source and the rendered output are two
different artefacts, and neither is evidence about the other.

**Already run Lighthouse instead? That works too** (Phase 32, new):

```bash
tewip access --report lighthouse-report.json
```

Lighthouse's accessibility audits *are* axe rules — same rule ids — so the same triage applies. Most
teams have Lighthouse in CI and no separate axe step; they get the whole of the above from a tool they
already run.

The catch was that a Lighthouse report strips axe's tags, so it says `landmark-one-main` and nothing
about which WCAG criterion that is, or whether it is one at all. That distinction covers **30 of axe's
105 rules**, and a remembered table of a hundred mappings is a table with mistakes in it. So the table
is **generated from axe-core itself** (`scripts/axe-rules.ts`) — 105 rules, 75 carrying a criterion, 30
best-practice only, none unclassified.

It also surfaces the **ten audits Lighthouse marks `manual`** — logical tab order, focus traps, whether
visual order follows the DOM. Those become questions, never passes. A page with no failures and ten
unanswered manual checks has not passed.

## Teach it your house rules (Phase 27)

```bash
tewip standards                        # what this project has taught Tewip
tewip standards --diff main...HEAD --strict
```

Tewip knows a lot that is true of software in general and nothing that is true of *your company*. Every
IT department has its own rules — "never drop a column in the release that stops writing to it",
"locators use data-testid", "no test may sleep" — and a tool that cannot be taught them is a tool that
argues with the house.

A standard is a markdown file in `.tewip/standards/`:

```markdown
---
description: A fixed wait hides a race instead of fixing it.
applies-to: tests/, e2e/
forbid: /waitForTimeout|sleep\(/ because a fixed wait passes by luck and fails in CI
---

Wait for the thing you are actually waiting for — an element, a response, a state —
never for a number of milliseconds.
```

**The split is the point.** The `forbid` and `require` lines are checked and enforced, with the offending
line quoted and your own reason printed beside it. The prose below is **guidance**: Tewip carries it into
whatever it writes or fixes, and quotes it in reports — but it is never counted as checked and never
reported as kept. A team that believes an unenforceable rule is being enforced is worse off than a team
with no tool at all, because they have stopped watching for it themselves. A rule Tewip cannot parse is
reported as unusable rather than silently dropped.

Once written, the rules appear everywhere the work is judged: in `tewip review`, in the pull request
comment, and as a question in `tewip done` — *"Does it keep this project's own standards?"* — which
answers **no** and names the rule. The guidance goes into the prompt when `tewip write` drafts a test, so
what comes back is in your conventions rather than Tewip's.

## What will this migration do to a live database? (Phase 26)

```bash
tewip schema --diff main...HEAD      # or: tewip schema migrations/0002_drop_nickname.sql
tewip schema --strict                # fails the build on a change that breaks the running version
```

The most expensive change in a pull request is usually not a test — it is a migration. A column dropped
while the previous deployment is still selecting it. An index built without `CONCURRENTLY`, blocking every
write to the busiest table. A `NOT NULL` added to a populated table. These are known, documented, and a
tool can name every one of them from the text of the migration.

```
1 of 1 migration file(s) read. 1 change(s) would break the running version or destroy data

## Breaks the version that is still running (1)
- drops the column nickname from orders — migrations/0002_drop_nickname.sql:1
  - Instead: deploy code that no longer selects or writes the column, then drop it in a later
    migration. During a rolling deploy the old version is still running and will fail on a column
    that is gone

## Code that still uses what this takes away (1)
- orders.nickname is still named in 1 file(s): app/orders.py
```

That last section is the part no SQL linter does: it searches your own code for what the migration takes
away. "This drops `users.nickname`, and four files still read it" is a different sentence from "dropping a
column is risky", and it is the one that stops the outage.

It reads **SQL, Django, Rails and Alembic** migrations, judges **only the forward path** (a rollback step
contains the mirror image of the change, so reading it says a migration that creates a table destroys
one), and stays quiet when the team already did the safe thing — `atomic = False`, `algorithm:
:concurrently`, `NOT VALID`, `postgresql_concurrently=True`. When it cannot read a migration it says so
rather than passing it, and "read and nothing found" never looks like "not read".

**Tried on real projects.** 200 Zulip migrations: 199 read, 19 changes that break the running version or
destroy data, each sampled finding correct when read against the file — including a `DROP COLUMN` buried
in raw SQL inside a Python data migration. 60 Mastodon migrations: it caught a `change_column` that
rewrites a table, in a migration whose *name* says it only adds one.

What it does not know, and says so: your table sizes and how busy the database is, so it reports what a
statement **does** — rewrites the table, scans every row, blocks writes — and leaves the duration to the
person who knows the data. In CI the findings go into the pull request comment, and anything that breaks
the running version enters the evidence bundle as a refusal: a passing test suite does not verify a
migration.

## Run only the tests that could notice this change (Phase 25)

```bash
tewip pick --diff main...HEAD     # or: tewip pick src/pricing.js
tewip pick --list                 # just the files, for piping into your runner
```

A forty-minute suite is a suite people stop running. Vendors sell this as a prediction - a model guesses
which tests matter - and a guess is the wrong shape for the job, because the cost of being wrong is a bug
reaching production and nobody can audit a guess.

Here, **skipping a test is a claim that it could not have noticed the change**, and a claim needs
evidence. A test runs when it imports a changed file, reaches one through another module, is edited by the
change itself, reads the repository at run time (a guard that scans every source file can be broken by any
file), or has failed recently — an unknown is never a skip. Everything else is left out with the reason
printed beside it.

**It refuses to narrow at all** when the change touches dependencies, build or test configuration, shared
setup or fixtures; when the suite drives a browser, because what a browser test exercises is not written
in its imports; or when a changed file cannot be traced to any test, since code is reachable in ways an
import does not show.

**Measured by breaking the code** (`eval/pick-safety.ts`): make a real mutation, ask `pick` what could
notice it, then run the **whole** suite to find out which tests really catch it. A failure is dropping a
catching test.

| Project | Judged cases | Catching test lost | Suite selected |
| --- | --- | --- | --- |
| This repository (node --test, 76 test files) | 8 | **0** | 7–9% |
| expressjs/express (Mocha, 88 test files) | 2 | **0** | refused to narrow — every test reaches the change |

Those two rows are the point. On a layered codebase it runs under a tenth of the suite and keeps every
test that would have caught the bug; on a monolith where every test imports the package front door it says
there is nothing to skip, rather than inventing a saving. It is also an MCP tool, so an agent can ask what
to run before running anything.

**In CI**, `mode: pick` runs before your tests and hands the workflow the files to run:

```yaml
- id: pick
  uses: hmamut39/tewip@main
  with: { mode: pick }        # needs fetch-depth: 0 on actions/checkout
- run: npx jest ${{ steps.pick.outputs.tests }}
  if: steps.pick.outputs.narrowed == 'true'
- run: npx jest
  if: steps.pick.outputs.narrowed != 'true'
```

Whatever it leaves out is written into the job summary with the reason beside it, so "why did CI not run
that test" is answered by the run itself. When it will not narrow safely, `narrowed` is `false` and
`tests` is empty - so a workflow that ignores the flag still runs everything, which is the safe default.

## Would your tests catch a bug? (Phase 23)

```bash
tewip prove src/pricing.js              # or --diff main...HEAD for what a change touched
tewip prove src/pricing.js --strict     # exits non-zero when something goes unnoticed
```

Coverage says a line ran. It does not say anybody checked it. `prove` settles that by **execution**:
it breaks your code in small, deliberate ways - a boundary moved by one, a condition inverted, an
`and` that became an `or`, a returned flag flipped, a pattern loosened - runs the tests that reach
that file, and reports every change **none of them noticed**.

```
4 change(s) were made to your code and the covering tests were run against each. 3 went unnoticed.

- line 2: a boundary moved by one
  - was:    if (total >= 100 && isMember) return 0.2;
  - became: if (total > 100 && isMember) return 0.2;
- line 9: a sign reversed
  - was:    return total - total * off;
  - became: return total + total * off;
```

Both of those are real: the tests used 150 and 10 and never the boundary itself, and the test calling
`finalPrice` asserted nothing at all. Neither gap is visible in a coverage report, because both lines
were covered.

It refuses more often than it reports, and the refusals are the reason the reports are worth reading:

- **Your file is put back exactly as it was**, byte for byte, line endings included, in a `finally` -
  and the restore is verified, not assumed. A restore that did not work is an error, not a shrug.
- **Nothing that can hang is touched.** Loop headers are never changed: a flipped comparison in a
  `while` does not fail a test, it runs forever.
- **A red suite proves nothing.** Every covering test is run untouched first. Ones that do not pass are
  set aside by name, and if none pass, it says so and stops - a test that was already failing would
  otherwise appear to "catch" every change.
- **It checks that your tests actually load the file.** If breaking the file outright does not fail a
  single test, they are reading an installed copy or a build output, and it says that instead of
  reporting a page of holes that do not exist. This caught a real case on the first Python project it
  met, where `import humanize` resolved to a different checkout entirely.
- **Strings and comments are never changed**, because changing a message is not a bug a test should be
  expected to catch.

It follows imports, so a file reached *through* another module is still proved - in a layered codebase
that is most of them. It needs a unit test framework (jest, vitest, mocha, `node --test`, pytest, go
test, maven, gradle, dotnet), calls no model, and costs nothing but time. It is also an MCP tool, so a
coding agent can ask whether the tests it is relying on would have stopped its own mistake.

## Could these tests ever fail? (Phase 22)

```bash
tewip vouch tests/            # or a file, or the whole project
tewip vouch tests/ --strict   # exits non-zero, for a merge gate
```

Most tests in a pull request are now written by an agent, and the question that decides whether they
are worth anything goes unasked: **could this test ever fail?** Coverage counts a test that checks
nothing. CI goes green on it. A reviewer skims something plausible and approves it.

`vouch` reads tests somebody else wrote and answers per test, quoting the line it rests on. It finds
tests that leave an expectation unfinished (`expect(value);` with no matcher - it reads exactly like a
check), tests that compare a value with itself, tests that catch and discard their own failure, tests
that never run, and tests that compare no value at all. No model, no cost.

It is also an MCP tool, so a coding agent can ask about the tests it just wrote before claiming a
change is covered.

**Measured on 5,448 tests in 8 public projects across 5 languages** (express, axios, chalk, requests,
click, gorilla/mux, cobra, gson): 19 tests were called unable to fail, and **all 19 were correct** when
read against the files - one unconditional skip in psf/requests, eighteen `@Ignore` methods in gson.

Two things it refuses to do, which is why the list is worth reading:

- **It will not guess.** A test whose checking happens inside a helper it cannot follow is reported as
  undecided, by name, never as worthless. A wrong accusation about somebody's test costs more than a
  missed one.
- **It will not overclaim.** A test with no assertion still fails when the code throws - in axios, a
  test that compiles a TypeScript fixture and runs it asserts nothing *on purpose*. Those are reported
  separately as "compares no value", not as broken, and they do not trip `--strict`.

**Recall, measured by execution** (`eval/vouch-recall.ts`): mutate a source file, record which tests
catch which mutation, remove the last statement of the ones that provably caught something, and run it
all again. A test that caught a mutation before and catches nothing now has provably lost its check -
a label that owes nothing to vouch's own patterns. On 17 such cases across seven source/test pairs in
two projects, **vouch named 12 (70.6%)**, and the five it did not name still hold a real assertion, so
it is right about those too. Nothing that still caught a mutation was wrongly accused.

## A goal instead of a verb (Phases 19 and 21)

```bash
tewip pursue "keep the checkout flow green"
tewip pursue "keep the checkout flow green" --act
```

Give Tewip a goal and it says what it would do next, and why, from what it can actually see. The
order is fixed, published and testable - **not chosen by a model**: a real bug first, then the
environment, then flakiness, then anything failing it cannot explain, then a test that cannot fail,
then a coverage gap, and only then is the goal worth attesting. Deciding the same state twice gives
the same answer.

With `--act` it carries the decision out, and this is where the refusals matter most:

- It **never does the work itself.** Each action is an existing command that already proves what it
  changes - `write` keeps a test only when it passes *and* fails when broken.
- **Two actions are on the allowlist**: write a missing test, and attest a green goal. Everything
  else is refused by name. It will not work around a real bug.
- **One action, then stop.** There is no unattended loop.
- Everything it did or refused goes to `.tewip/actions.jsonl`, with the run that justified it.
- It **will not repeat itself**: the same attempt is refused until a new run gives it new evidence.

## Where it has been tried

| Project | How | Result |
|---|---|---|
| A private practice repository (not linked: it is private) | Live GitHub Action on a release PR with 11 planted failures | Diagnosis comment, one environment issue, and a fix PR whose 5 locator changes pass when checked out. Traps left alone. Synthetic. |
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
| `timing-intercepted` | TIMING | the element was ready, but the error says another element (a snackbar, menu or overlay) intercepts pointer events, so the click could not land. Also Selenium's `Other element would receive the click` and Cypress's `is being covered by another element` (0.65 until measured on labelled data) |
| `timing-stale-element` | TIMING | Selenium's `StaleElementReferenceException` or Cypress's `the page updated while this command was executing`: the page replaced the element between finding and using it (0.65 until measured) |
| `timing-retry-pass` | TIMING | another attempt of the same code in the same run passed |
| `timing-known-flaky` | TIMING | a known flaky test: in an earlier run it failed with this same error and then passed on a retry. Steps back when a request failed during the test |
| `locator-drift` | LOCATOR_DRIFT | the element was never found (Playwright, Selenium `NoSuchElementException`, WebdriverIO, Cypress `Expected to find element`), but the page snapshot has an element with a similar name (similarity ≥ 0.6). Declines when the test has no recorded passing run: nothing then shows the element ever matched. |
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

Every triage run, the CLI, the eval and the CI job summary end with one line: how many model calls were made, how long they took, how many came free from the cache, the tokens used, and the cost in dollars. Each call is priced by its own model from OpenAI's published prices (cached input at the cached rate); a team with its own price sets `TRIAGE_LLM_PRICE_IN/OUT`, and a model with no known price is reported as such, never guessed. A run is cheap because the deterministic rules answer most failures and only what they cannot settle reaches the model. Measured example (JupyterLab, 41 real failures): the rules decided 34 of them, 6 went to the model, and those 6 calls took 30 seconds and about 31,000 tokens in total.

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
- `TRIAGE_LLM_PRICE_IN` / `TRIAGE_LLM_PRICE_OUT`: your own price per million input / output tokens, overriding the published prices built in for OpenAI's models. For a model without a built-in price, set them to see a cost; otherwise the run says the price is unknown.
- `CI_RUN_ID`: used as the run id. If it is not set, the run id is based on a timestamp.
- `GIT_SHA` or `GITHUB_SHA`: stored as the record's `gitSha`. If neither is set, `gitSha` is left empty.

**Data leaving the machine:** with the LLM layer on, the summary of each UNKNOWN failure is sent to OpenAI. That summary includes the error text, the page snapshot, failed request URLs (without query strings) and console errors. Nothing is committed to git.
