# Quickstart: putting Tewip on one repository

For an engineer adding the agent to a project that already runs Playwright tests in GitHub Actions. It takes about ten minutes, and the first useful output arrives with the next failing run.

Start with **one** repository whose tests fail sometimes. A repository whose suite is always green has nothing to triage.

## What the agent does once it is installed

Every CI run, for every failed test, it decides the root cause — application bug, changed selector, race, environment, or test data — with a confidence, the evidence it used, and one concrete next action. It then delivers that to the people who need it: a comment on the pull request, the board in the job summary, one grouped issue for environment failures, and optionally a separate pull request with locator fixes that it re-ran and verified.

It never merges anything, never edits application code, and never opens a fix pull request for a change it has not proved by re-running the test.

## Step 1: make Playwright leave the evidence behind

The agent reads Playwright's own blob report and traces, so nothing from this project goes into your test config:

```ts
// playwright.config.ts
reporter: process.env.CI ? [['list'], ['blob']] : 'list',
use: { trace: 'retain-on-failure' },
```

If your config already uses a reporter list in CI, add `['blob']` to it.

## Step 2: add one step to the workflow that runs the tests

```yaml
permissions:
  pull-requests: write     # the diagnosis comment
  issues: write            # the grouped environment issue
  contents: write          # only if you turn autofix on

steps:
  # ... your existing checkout, install, and `npx playwright test` steps ...

  - name: Tewip
    if: always()           # it must run even though the test step failed
    uses: hmamut39/tewip@main
    with:
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}   # optional, see step 3
      autofix: 'false'                                # start with this off
```

`if: always()` matters: without it the step is skipped exactly when there is something to triage.

Keep `autofix: 'false'` for the first week. Read what the agent says, decide whether you trust it, and turn fixing on afterwards.

## Step 3: decide whether to give it an API key

| Without a key | With `OPENAI_API_KEY` |
|---|---|
| Only the deterministic rules run | The rules run first, and only what they cannot settle goes to the model |
| Every answer is explainable from the error, the trace and the test's history | Adds a judgement on the rest, with its reasoning and evidence shown |
| Free | A few cents per run in practice, because the rules answer most failures |

On real projects the rules alone decide most failures and are right on 96–98% of what they decide, so starting without a key is a reasonable first week. To add one later: repository **Settings → Secrets and variables → Actions → New repository secret**, named `OPENAI_API_KEY`.

Two guards worth setting once the key is in place:

```yaml
env:
  TRIAGE_LLM_MAX_CALLS: '80'     # hard cap on model calls per run
  TRIAGE_LLM_PRICE_IN: '0.25'    # your price per million input tokens
  TRIAGE_LLM_PRICE_OUT: '2'      # per million output tokens, so every run prints what it cost
```

## Not using Playwright? Every stack works

Point the agent at your test runner's **JUnit XML** report (or .NET's **TRX**) instead of a Playwright blob report. Each runner marked *verified* was run for real in CI (`fixtures/polyglot`) and its report is checked by the test suite on every change.

| Stack | Runner | How to write the report | Status |
|---|---|---|---|
| **Node.js** | node:test (built in) | `node --test --test-reporter=junit --test-reporter-destination=report.xml` | verified |
| Node.js, React, Vue, Angular, Next.js, NestJS, Express | Jest | `jest --reporters=default --reporters=jest-junit` | verified |
| Vite, Vue, Svelte, Nuxt, React | Vitest | `vitest run --reporter=junit --outputFile=report.xml` | verified |
| Node.js, Express | Mocha | `mocha --reporter mocha-junit-reporter` | verified |
| **Python**, Django, Flask, FastAPI | pytest (also runs `unittest`) | `pytest --junitxml=report.xml` (retries: `pytest-rerunfailures`) | verified |
| **Java**, Spring, Kotlin | JUnit 4/5, TestNG via Maven Surefire | written by default to `target/surefire-reports/` (retries: `rerunFailingTestsCount`) | verified |
| Java, Kotlin, Android | Gradle | written by default to `build/test-results/test/` | same format as Surefire |
| **Go** | gotestsum | `gotestsum --junitfile report.xml` | verified |
| **.NET** (C#, F#), ASP.NET | xUnit, NUnit, MSTest | `dotnet test --logger trx` (native) or `--logger junit` | both verified |
| **Ruby**, Rails | RSpec | `rspec --format RspecJunitFormatter --out report.xml` | verified |
| **PHP**, Laravel, Symfony | PHPUnit | `phpunit --log-junit report.xml` | verified |
| **Rust** | cargo-nextest | `[profile.ci.junit]` in `.config/nextest.toml` | verified |
| End-to-end | **Selenium** (Java, Python, JavaScript, C#) | through the runner above it: Surefire, pytest, Jest/Mocha, `dotnet test` | JUnit format; error wording read |
| End-to-end | Cypress, WebdriverIO | `mocha-junit-reporter` / `@wdio/junit-reporter` | JUnit format; error wording read |
| End-to-end | **Playwright** | blob reporter (step 1) — adds traces, selector drift and verified fixes | verified on 5 real projects |

```yaml
      - name: Tewip
        if: always()
        uses: hmamut39/tewip@main
        with:
          junit-report: report.xml     # a file, or a directory of them (.xml and .trx)
          suite: unit                  # only needed when one workflow triages several suites
```

What it reads from any of these: the failure text, retries, and each test's history. From that it tells apart a wrong value (a real bug once the test has a passing history), an unreachable service (environment), a data collision, and a test that failed then passed on a retry (timing), in the wording each language uses: `expected: <4> but was: <3>` in Java, `got 3, want 4` in Go, `AssertionError: 3 != 4` in Python, `Expected: 4 / Actual: 3` in .NET, and so on. It also reads each browser tool's own words for the same three problems: an element that was never found (Selenium's `NoSuchElementException`, WebdriverIO's `still not displayed`, Cypress's `Expected to find element`), a click another element received (Selenium's `Other element would receive the click`, Cypress's `is being covered by another element`), and an element the page replaced mid-test (Selenium's `StaleElementReferenceException`, Cypress's `the page updated while this command was executing`). No labelled Selenium or Cypress runs have measured those rules yet, so they report at a confidence the merge gate does not trust on its own. What it cannot do without Playwright's traces is look at the page, so selector drift and automatic fixes stay Playwright-only.

A wrong value on a test's **first** recorded failure stays undecided rather than guessed: one failure alone does not show whether the test was reliable before. It becomes a real-bug diagnosis once the test's history shows it passing and then failing the same way.

When one workflow triages several suites (say `unit` and `e2e`), give each a `suite` name: each then keeps its own history and its own comment, and corrections name the suite, as in `/triage TIMING unit#2 flaky on CI`.

## On your own machine, without CI

Install the command once from the release file, `npm install -g tewip-<version>.tgz` (Tewip is not on the npm registry yet; Node 22.18 or newer), run your tests with the report switched on (see the table above), then:

```bash
tewip explain report.xml          # JUnit XML or .trx
tewip explain reports/            # a folder of them
tewip explain blob-report/        # Playwright
tewip ci owner/repo --pr 12       # what Tewip's GitHub Action said about a pull request
```

It prints the same triage board CI writes: each failure's cause, confidence, evidence and next action. Each run is kept in a `.tewip/` folder in your project (add it to `.gitignore`), so from the second run on, failures are judged against their history exactly as in CI. `--name` keeps separate histories for different projects.

## What you will see on the next failing run

- **On the pull request:** one comment listing each failing test, grouped by whether your change likely caused it, each with a cause, a confidence, the evidence and the next action. It updates in place rather than adding a comment per run.
- **In the job summary:** the same failures as a triage board.
- **As an issue:** environment failures (5xx responses, connection resets, outages) grouped into one issue instead of one per test.
- **As an artifact** named `tewip-report`: every role's view, including the engineering-quality view with the flaky tests ranked by the CI minutes they cost.

## Correcting it

When it gets one wrong, reply to its comment:

```
/triage TIMING #2 this one is flaky on our CI runners, not a bug
```

From the next run on, that failure of that test gets your answer, shown as "corrected by a person" with your name and reason. A correction settles the cause; it never makes the agent change code.

## Asking it questions from your editor

- **VS Code, Cursor, Windsurf, VSCodium:** install the Tewip extension (*Extensions → … → Install from VSIX*, `tewip-<version>.vsix`). It connects Tewip to the editor's AI assistant by itself and adds *Tewip: Explain a test report…* and *Tewip: Why did CI fail on this branch?*
- **JetBrains (2025.2+), Claude, and other MCP clients:** add one server whose command is `tewip mcp`.

Then ask, in plain language: "why did CI fail on my PR?", "which tests are flaky in checkout?", "is main safe to release?". Every tool is read-only, and it reads the report the Action already uploaded, so you do not need the other repository cloned.

## Stop flaky tests from blocking merges (optional)

Once you trust its answers, let the agent decide whether a failed run should block:

```yaml
      - name: Tests
        continue-on-error: true      # the gate below decides
        run: npx playwright test
      - name: Tewip
        if: always()
        uses: hmamut39/tewip@main
        with:
          gate: real-failures
```

The build then fails only for real bugs, changed selectors, test-data problems and anything undecided. Failures a rule or a person classified as flaky or environment no longer block. On 2,296 real failures this unblocked 84% of the flaky and environment ones without letting a real bug through.

## Turning fixing on, once you trust it

```yaml
      autofix: 'true'
```

It then rewrites a drifted locator, re-runs that single test, and opens a **separate** pull request only with the changes that passed. Review it like any other pull request: an intended UI change and a regression can look identical from the outside, which is exactly why a human merges it.

On real WordPress CI data it would have fixed 14 drifted locators with none wrong, and every locator it suggested matched what the developers themselves wrote.

## If something does not appear

| Symptom | Cause |
|---|---|
| The step ran but says "no blob report" | The blob reporter is not on in CI, or the tests step did not run |
| No comment on the pull request | The run was not triggered by a pull request, or `pull-requests: write` is missing |
| "Resource not accessible by integration" | The workflow's permissions block is missing an entry |
| Diagnoses look thin on the first day | The agent judges each failure against that test's history, which it builds from your runs; it gets better as runs accumulate |

## What it costs, and what it keeps

The agent stores the run history in the Actions cache, never in your repository. Collected failure data and traces stay in CI. The only thing it writes to your repository is a pull request branch, and only when you turn fixing on.
