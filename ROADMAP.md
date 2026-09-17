# triage-agent ROADMAP

## Product Purpose
Compress a QA engineer's morning triage (200 failed cases, ~3 hours of manual root-cause judgment) down to under 20 minutes.

Input: one failed Playwright CI run
Output: root cause classification + confidence + evidence for each failure; auto-fixable ones become a PR

## Core Design Principles
1. Collection before intelligence. Any judgment without historical data is guesswork
2. Rules before models. Cases decidable by deterministic logic never go to an LLM — cheaper and more accurate
3. One engine, many outlets. Diagnosis logic is written once; rendering layers differ by role
4. Data never leaves the repo boundary. Collected failure data is never committed to git
5. Every phase must produce a quantifiable metric. No vibes

## Five Root Cause Categories (fixed taxonomy, the model may never invent new ones)
- REAL_BUG — the application is actually broken
- LOCATOR_DRIFT — element still exists, selector no longer matches
- TIMING — insufficient wait or race condition
- ENV — environment, dependent service, or auth problem
- TEST_DATA — incorrect preconditions or fixture data

## Phases

> Order changed on 2026-09-13 at the owner's request: the multi-role outlets (formerly Phase 5) now come before the auto-fix loop (formerly Phase 4), and the outlets now serve the whole senior engineering organisation, not only QA.

### Phase 1: Collection Layer (DONE)
Custom reporter writes failure records to JSONL; history script aggregates failure rates and flags SUSPECTED_FLAKY.

### Phase 2: Rule-Based Diagnosis Layer (BUILT — coverage target missed on synthetic data: 43.5% vs 50%)
Create an engine/ directory with a purely deterministic rule engine. Input: one failure record + that test's history. Output: one of the five categories + confidence score + evidence explanation.

Rules must include at minimum:
- Many tests failing in the same run → ENV
- Error message contains network/connection/5xx keywords → ENV
- Historical failure rate between 20%-80% with inconsistent error messages → TIMING
- Element-not-found error, but a textually similar element exists in the page snapshot → LOCATOR_DRIFT
- Assertion value mismatch on a test with a stable history → REAL_BUG

Anything the rules cannot decide is marked UNKNOWN with confidence 0 and left for Phase 3.

Phase metric: run against all collected history and print the coverage ratio (share of non-UNKNOWN classifications). Target ≥ 50%.

### Phase 3: LLM Diagnosis Layer (BUILT — held-out real accuracy 83.2%, see caveats in eval/README.md)
> Held-out set: 155 real WordPress Gutenberg CI failures (Sep 4–7 2026), labelled by Claude from CI evidence, never used for tuning. 83.2% overall; but on the cases whose labels do not share a signal with the rules, accuracy is 10/36 (recurring cross-branch flakes 0/22, PR-caused REAL_BUG 10/14). TEST_DATA and LOCATOR_DRIFT are not yet measured on real data.
Handles only the cases Phase 2 marked UNKNOWN.
- Extract DOM snapshot, network log, and console output from trace.zip; send a structured summary to the model, never raw logs
- Enforce JSON schema output; the model may only return one of the five categories
- Write the result into the record's diagnosis field
- Create an eval/ directory holding a hand-labeled ground truth dataset, plus a script that computes accuracy

Phase metric: overall classification accuracy ≥ 80%.

### Phase 4: Multi-Role Outlets (moved up from Phase 5) (BUILT — metric met: 223/223 on 41 real failed Gutenberg runs; see caveat)
> The metric checks routing and completeness of the views, which the code controls, so meeting it says nothing about usefulness. Usefulness needs real users (Definition of Success). Reading the real views exposed a classifier weakness: expected server errors inside error-handling tests are read as ENV.
The engine emits one unified diagnosis object. Every view renders that same object, and each one shows the diagnosis's confidence and data source and ends in a concrete next action, not just a status:
- PR comment (developers): does this failure relate to your change, with the evidence and the suggested fix
- Engineering-quality view (senior / principal engineers): recurring root-cause patterns, flakiness hotspots by component, test-design debt (hard waits, brittle selectors) ranked by cost
- Architecture view (architects): cross-cutting fragility, i.e. which modules, shared components and service dependencies cause the most REAL_BUG / ENV failures, and changes that break many suites at once
- Infrastructure view (senior DevOps / SRE): ENV failures grouped by dependency, runner or service, with the re-run result and a single grouped alert
- CLI triage board (SDETs): classification + evidence + suggested fix
- Weekly risk digest (leads / managers): which modules are degrading
- Release-readiness report (UAT business users): which business flow is broken, in plain language
- Delivery, added 2026-09-16: a GitHub Action posts the PR comment, collects environment failures in one issue, writes the SDET board to the job summary, and uploads every view. An MCP server lets anyone's AI assistant (Claude, Cursor, VS Code) query the same diagnoses and views, e.g. "why did CI fail on my PR?". Branch-aware: regressions caught inside pull requests are no longer counted as main-branch product bugs.

Phase metric: on a real failed CI run, ≥ 90% of failures appear in the right role's view with a concrete next action and its evidence, and no view ever shows a diagnosis without its confidence and data source.

### Phase 5: Auto-Fix Loop (moved down from Phase 4; gated by the Reality Check Gate) — IN PROGRESS
> Status 2026-09-15: the loop runs end to end in a local drift lab (synthetic: 5/6 fixed and verified, 0/5 false fixes). Real LOCATOR_DRIFT classification is weak (1/7 across the held-out and fresh sets), so auto-fix is restricted to drift the deterministic rule matched on the page. On 590 real labelled failures that currently means 0 autonomous fixes. Fresh real-data accuracy (Sep 1–3, frozen pipeline): 89.9%.
>
> Status 2026-09-16: first live run in GitHub CI, in the private practice repo hmamut39/triage-agent-sandbox (a release PR with 11 planted failures; synthetic, not a product metric). The agent posted the diagnosis comment on PR #1, opened one environment issue (#3), and opened fix PR #2 with 5 locator fixes. Checked out independently, exactly those 5 tests pass, and the removed features, wrong price, disabled button and outage were left untouched. VERIFY now feeds DECIDE: every lower-confidence locator suggestion is re-run too, and a suggestion that still fails is escalated as a possible real bug instead of being offered as a fix. It has not been used on a real team's repository yet.
> Status 2026-09-17: LOCATOR_DRIFT is now measured on real data. 23 drift cases were mined from the fixes Gutenberg developers made (the fix replaced the failing locator with one for the same element): the pipeline gets 14/23 = 61%, and 5 of 29 real bugs are called drift. On those 216 labelled failures the agent would have made 0 automatic code changes, so the safety rules hold, but autonomy on real projects is still 0. Shadow runs on Supabase and Penpot show it works on other projects; Ghost cannot be harvested from outside (reports live ~1 day, failures only).

Applies to LOCATOR_DRIFT only:
Pull candidate elements from the DOM snapshot → rank by similarity → generate a new locator → re-run that single test locally → only generate a PR if it passes; discard otherwise.

Phase metric: auto-fix success rate, plus false-positive rate (incorrect fixes must be near zero).

### Beyond Phase 5: Continuous Improvement
The agent keeps getting stronger after the last phase, but only in measured steps: every human correction becomes a labelled example, misclassifications drive new rules or prompt changes, accuracy and autonomy rate are re-measured on real data after every change, and a change that lowers either is reverted.

## Definition of Success
Two weeks of real team usage with triage time dropping from 3 hours to under 20 minutes.

## What This Is: An Agent, Not a Dashboard

This project builds an autonomous agent that takes actions, not a tool that produces reports for a human to act on. Every phase must be designed so its output feeds an action, not a screen.

The agent's operating loop:
1. OBSERVE — detect a failed CI run, pull records, traces, git diff
2. ORIENT — classify root cause using rules, then LLM for the remainder
3. DECIDE — choose an action per failure based on category and confidence
4. ACT — execute it
5. VERIFY — re-run the affected test and confirm the action worked
6. LEARN — write outcome back to history so future decisions improve

Actions the agent is authorized to take autonomously:
- LOCATOR_DRIFT, confidence > 0.85 → rewrite the selector, re-run the test, open a PR if green
- TIMING, confidence > 0.85 → replace a hard wait with a proper wait condition, re-run, open a PR if green
- ENV, any confidence → do not touch code; re-run the affected tests once to confirm, then post a single grouped notice
- TEST_DATA → do not touch code; report with the specific missing precondition identified
- REAL_BUG → do not touch code; file an issue with reproduction steps and the trace attached
- UNKNOWN or confidence below threshold → escalate to human with everything it gathered

Hard constraints on autonomy:
- The agent never merges anything. It opens PRs; humans merge
- The agent never modifies application source code, only test code
- Every action must be verified by re-running the test before the agent reports success
- If a fix attempt fails verification, discard it and escalate. Never open an unverified PR
- Every action is logged with the reasoning and evidence that triggered it

The success criterion is the autonomy rate: the percentage of failures resolved end-to-end without a human touching them. Phase 5 target: 40% or higher.

## Reality Check Gate (mandatory, non-negotiable)

The five synthetic test cases in tests/ exist only to build and debug the pipeline. They are NOT evidence that this tool works.

Before the Auto-Fix Loop (Phase 5) begins, this gate must be passed. Phase 4 views may be built before it, but they must label every diagnosis with its confidence and data source:

1. I will collect 100 real failure cases from actual CI runs and hand-label each with one of the five root cause categories. This becomes eval/ground-truth.jsonl
2. The Phase 2 rule engine and Phase 3 LLM layer are measured against this real dataset, not against synthetic tests
3. If accuracy on real data is below 80%, do not proceed to the Auto-Fix Loop (Phase 5). Instead, analyze the misclassifications, report which categories are failing and why, and propose rule or prompt changes

Never report a metric computed on synthetic test data as if it were a product metric. Always state clearly which dataset a number came from.

## Anti-Scope-Creep Rules

- Do not add a web UI, dashboard, authentication, or database before Phase 4 (Multi-Role Outlets)
- Do not add support for other test frameworks (Cypress, Selenium, Jest) — Playwright only
- Do not add multi-tenancy, billing, or user accounts at any phase in this repo
- If I ask for something outside the current phase, remind me which phase it belongs to and ask whether I want to reorder deliberately

## Working Agreement

- At the end of every phase, print: what was built, the phase metric, and what the next phase needs from me
- If a phase metric target is missed, say so plainly. Do not soften it or move the goalposts
- Keep every file under 300 lines. Split when it grows past that
