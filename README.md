# Tewip

**Tewip** (Uyghur *téwip*, تېۋىپ: healer, doctor) finds why each failing test failed: a real bug, a flaky test, the environment, test data, or a changed selector. Every answer comes with its confidence, its evidence and one next step, and names its source: a deterministic rule, the AI model, or a person's correction.

It works for every stack: Node.js (node:test, Jest, Vitest, Mocha), Python (pytest, unittest), Java and Kotlin (JUnit, TestNG), Go, .NET, Ruby, PHP and Rust, each checked against its real runner's report ([the full list](QUICKSTART.md#not-using-playwright-every-stack-works)), plus Playwright in depth with traces, selector drift and verified fixes. It also reads the failure wording of the browser and component-test tools on top of those runners (Selenium, WebdriverIO, Cypress, Testing Library for React, Vue and Angular, Vue Test Utils, jest-dom and Jasmine), checked against more than 500 real messages from public projects.

| Where | How |
|---|---|
| **Terminal** | `npm install -g tewip-ai`, then `tewip explain report.xml`, `tewip ci owner/repo --pr 12`, `tewip mcp` |
| **VS Code, Cursor, Windsurf, VSCodium** | the Tewip extension: registers Tewip with the editor's AI assistant and adds *Explain a test report* and *Why did CI fail on this branch?* |
| **JetBrains, Claude, other AI assistants** | add the MCP server `tewip mcp` (see [editor setup](#use-it-from-your-editor-any-ide-that-speaks-mcp)) |
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

This came out of a measurement rather than an idea. Of 18 real pull requests later found to have
broken something, the one Tewip's test plan missed was one whose *intention* was wrong: it changed
a freshness rule, changed the tests to match, and was reverted the next day. Run over those same 18
pull requests, this check fires on 2 — **and both were reverted**, including the one the plan
missed. No model is called, so it costs nothing.

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
