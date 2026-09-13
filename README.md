# triage-agent

A triage tool for Playwright test failures.

**This is phase 1: the collection layer.** It records every failed or timed-out test attempt and computes failure history per test. There is no AI model in this phase. **Phase 2 will add a diagnosis layer**: an LLM will read these records, including traces and screenshots, and fill in each record's `diagnosis` field.

## How it works

- `reporters/triage-reporter.ts` is a custom Playwright reporter. It runs alongside `list`. For every attempt with status `failed` or `timedOut`, it captures the error, stack, duration, retry, trace and screenshot paths, run id and git SHA. When the run ends, it **appends** those records to `data/triage.jsonl`. It also appends one summary line per run to `data/runs.jsonl`, which records how many times each test ran. The history script uses that count to calculate failure rates.
- `scripts/history.ts` groups the records by test and prints a table with runs, failures, failure rate, last failure time and whether the error was the same each time. A test is flagged `SUSPECTED_FLAKY` when its failure rate is between 20% and 80% and its error messages vary.
- `tests/` contains 5 tests that fail on purpose: missing selector, timeout, assertion, network error and a roughly 50% flake. They run against `fixtures/index.html`, served by a small local server (`fixtures/server.ts`), so everything works offline.

`data/` is gitignored because the collected data stays local. Each run writes its artifacts to `test-results/<runId>/`, so trace and screenshot paths from older runs keep working.

## Usage

Requires Node >= 22.18. Node runs the `.ts` scripts directly.

```bash
npm install
npx playwright install chromium

npm test              # one run
npm run test:loop     # 5 runs in a row, to build up history
npm run history       # aggregated table
```

Environment variables:

- `CI_RUN_ID`: used as the run id. If it is not set, the run id is based on a timestamp.
- `GIT_SHA` or `GITHUB_SHA`: stored as the record's `gitSha`. If neither is set, `gitSha` is left empty.

## Extension points for phase 2

- `reporters/types.ts`: `TriageRecord.diagnosis?: Diagnosis` is reserved and never set in phase 1.
- `TriageReporter.enrich()`: a hook that runs before records are saved. Right now it passes records through unchanged.
- `reporters/store.ts`: shared JSONL read and write code. A future offline `diagnose` step can reuse it.
