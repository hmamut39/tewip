# triage-agent

A triage agent for Playwright test failures. See [ROADMAP.md](ROADMAP.md) for the full plan.

**Status: phases 1 to 4 are built.** Those are collection, rule-based diagnosis, LLM diagnosis with a real-data eval, and multi-role views. Held-out accuracy on 155 real Gutenberg CI failures is 83.2%; the caveats are in [eval/README.md](eval/README.md). Phase 5 (auto-fix) is next on the roadmap.

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
| `locator-drift` | LOCATOR_DRIFT | the element was never found, but the page snapshot has an element with a similar name (similarity ≥ 0.6) |
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
- It acts only on drift diagnosed by the deterministic `locator-drift` rule above 0.85. On real CI data the AI alone called real bugs "drift" at 0.88–0.96, so AI-only drift goes to a person.
- Every decision is logged with its reason, and it never pushes or merges.

`npm run lab` runs the whole loop against `lab/app`. Version v1 is what the tests were written for. Version v2 is a release with 6 renamed or re-shaped elements and 5 traps: removed features with look-alike elements, a wrong price, a disabled button, a server outage, and a test without assertions. The ground truth is in `lab/cases.json`. The current result is **5/6 drifted locators fixed and verified, 0/5 false fixes**. This is synthetic data and not a product metric. On 590 real labelled Gutenberg failures, the current rules would auto-fix **0**: every high-confidence drift call there came from the AI alone.

## Known issues (found on real data)

- **Drift and real bugs are hard to tell apart.** Measured on the held-out and fresh real sets, real LOCATOR_DRIFT was classified correctly in 1 of 7 cases, and a few real bugs were called drift. The auto-fix safety rule above keeps that from turning into code changes.
- **Expected server errors (partly fixed).** Tests that deliberately provoke server errors used to be read as ENV. The model is now told when a test's name says it exercises error handling (prompt llm-4).
- **Views can't tell pull-request branches from the main branch yet.** Records don't store the branch, so regressions inside unmerged PRs count as product bugs in the architecture view and the digest.
- **Some recurring flakes are misread.** Flaky tests that also fail on other branches are misclassified (0/22 on the held-out set), and TEST_DATA and LOCATOR_DRIFT are not yet measured on real data.

Environment variables (you can put them in `.env`, which is gitignored):

- `OPENAI_API_KEY`: turns the LLM layer on. Without it, only the rules run.
- `TRIAGE_LLM=off`: turns the LLM layer off even when a key is set.
- `TRIAGE_LLM_MODEL` (default `gpt-5.4-mini`) and `TRIAGE_LLM_REASONING` (default `low`): choose the model and its reasoning effort.
- `TRIAGE_LLM_CACHE=off`: skips the response cache in `data/llm-cache.jsonl`. With the cache on, an unchanged request is answered from the cache for free.
- `CI_RUN_ID`: used as the run id. If it is not set, the run id is based on a timestamp.
- `GIT_SHA` or `GITHUB_SHA`: stored as the record's `gitSha`. If neither is set, `gitSha` is left empty.

**Data leaving the machine:** with the LLM layer on, the summary of each UNKNOWN failure is sent to OpenAI. That summary includes the error text, the page snapshot, failed request URLs (without query strings) and console errors. Nothing is committed to git.
