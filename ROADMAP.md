# Tewip ROADMAP (formerly triage-agent)

## Product Purpose
Compress a QA engineer's morning triage (200 failed cases, ~3 hours of manual root-cause judgment) down to under 20 minutes.

Input: one failed CI test run (Playwright in depth; any framework that emits JUnit XML since 2026-09-19)
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

### Phase 2: Rule-Based Diagnosis Layer (BUILT — target met on real data: 77.4% coverage at 98.4% correct; 43.5% was the synthetic figure)
Create an engine/ directory with a purely deterministic rule engine. Input: one failure record + that test's history. Output: one of the five categories + confidence score + evidence explanation.

Rules must include at minimum:
- Many tests failing in the same run → ENV
- Error message contains network/connection/5xx keywords → ENV
- Historical failure rate between 20%-80% with inconsistent error messages → TIMING
- Element-not-found error, but a textually similar element exists in the page snapshot → LOCATOR_DRIFT
- Assertion value mismatch on a test with a stable history → REAL_BUG

Anything the rules cannot decide is marked UNKNOWN with confidence 0 and left for Phase 3.

Phase metric: run against all collected history and print the coverage ratio (share of non-UNKNOWN classifications). Target ≥ 50%.

Status (2026-09-23): **met, and measured the way the metric says - against all collected history,
not the synthetic set.** The 43.5% in the old heading came from synthetic failures. On 3,556 real
collected failures across eleven datasets from six public projects the rules decide **75.1%** on
their own; on the six datasets that also carry labels it is 77.4%.

Coverage on its own would be a number worth nothing, so here is the other half: on every labelled
case the rules decided, they were right **1,979 times out of 2,012 = 98.4%** (Supabase 100%,
August 99.4%, fresh 98.3%, dev 97.8%, August-2 96.7%, held-out 93.1%).

| | share | accuracy |
| --- | --- | --- |
| Decided by rules, no model call | 77.4% | 98.4% |
| Sent to the model | 22.6% | see Phase 3 |

Almost three quarters of that work is done by five rules: `timing-retry-pass` (71.3% of all rule
decisions), `env-network` (14.9%), `real-bug-assertion` (5.4%), `timing-flaky` (3.1%) and
`env-server-error` (1.9%).

**What it costs, measured rather than estimated.** A failure the rules decide costs nothing at all.
Three real uncached calls on held-out failures billed 3,624 prompt and 499 completion tokens each,
$0.00496 a call at gpt-5.4-mini's published price - so triaging **1,000 real failures costs about
$1.12**, and a real week costs less because repeated failures are answered from cache. (A first
estimate of $0.89 was made by counting characters; the real calls showed it was low, chiefly
because reasoning tokens are billed as output. The measured number is the one kept.)

### Reading a real project Tewip had never seen (2026-09-23)

The reader had only ever been checked against reports collected for this project. So piscina, a
public Node worker-pool library, was cloned, built and run here: 152 real tests, five green runs,
and two more at four times the concurrency to try to provoke a flake. It never flaked, which is a
compliment to piscina and left nothing to diagnose - but reading its output found a fault worth
more than a diagnosis would have been.

**Tewip announced two failing tests in a run where nothing failed, and called them flaky.** The
cause was an inference meant for re-run plugins: pytest-rerunfailures writes a test that failed and
then passed as two entries with no error recorded in either, so an adjacent duplicate name was
taken as a hidden failed attempt. node:test's JUnit reporter also writes a name twice - once for a
subtest, once for its parent - and those tests had simply passed.

A test that passed must never be reported as having failed, so the inference now needs evidence
that the run re-ran anything: a rerun element, or some test in the same report written twice with a
failure recorded. pytest's flake is still read; piscina's green run now reads as
"All 145 test(s) passed. Nothing to explain." Both shapes are tests now.

A second stranger followed: humanize, a Python library, run here with pytest. Its first run failed
to collect at all because a dependency was not installed, and Tewip answered **UNKNOWN six times**
to the single commonest environment failure there is. Once the dependencies were installed, 729
tests passed and 15 failed with "fixture 'benchmark' not found" - a plugin that was not there - and
Tewip answered UNKNOWN fifteen more times. Asked with the model on, it called those 15 **identical**
failures 13 ENV and 2 TEST_DATA: the same input getting different answers, which is worse than
either answer on its own.

Both are now a deterministic rule, `env-missing-dependency`, which reads "no module named" across
Python, Node, Java, Ruby, Go, .NET and PHP, and treats a missing pytest fixture as a missing plugin
**only when at least three tests in the run all want the same one** - a typo in a fixture name
breaks the one test that made it, an uninstalled plugin breaks every test that asks. Both real
reports now read as ENV at 0.85-0.92, deterministically and at no cost.

Two things are deliberately left alone, because they are not the machine's fault: a module that
belongs to the project itself (a rename that missed a caller is a real bug) and a file that will
not parse. `ImportError: cannot import name 'x'` is left out for the same reason - it usually means
the code asked for something that no longer exists.

These are the first defects found by pointing Tewip at strangers' projects rather than at data
collected for it, and they are the kind only that can find: every report in the eval sets came from
runners already known to work. Accuracy on all six labelled sets is unchanged: 96.4%, 86.1%, 93.4%,
97.9%, 89.0%, 99.7%.

### Reading other people's reports, in languages this machine cannot run (2026-09-23)

Go, Rust, Java, .NET, Ruby and PHP are not installed here, and installing six toolchains to test a
**reader** would be the wrong way round: a report is the whole input a reader takes, and public
repositories are full of reports that real CI really produced. Ten were fetched, from ten
repositories, across five runners: Maven Surefire, Gradle, gotestsum, cargo-nextest and NUnit.

**One crashed Tewip outright.** Maven Surefire writes `timestamp="2026-01-30T14:41:12 IST"` - a
timezone abbreviation with no offset, which no parser accepts - and `new Date(...).toISOString()`
threw, so importing a Surefire report stopped the tool dead. Every Surefire fixture collected for
this project happened to carry a clean timestamp, so nothing here could have found it. A report
Tewip cannot date is still worth reading, so an unreadable timestamp now falls back to the time of
import. It is a test.

The harvest then widened to the runners the first search missed. **26 real reports from 25
repositories, across 12 runners**: Maven Surefire, Gradle, gotestsum, cargo-nextest, NUnit, vstest
(TRX), PHPUnit, RSpec, pytest, Jest, Karma and Google Test - including protobuf's and nesper's own
CI output. **All 26 now read exactly as the report declares**, and finding that took a second fix:

A report whose root element is `<testrun>` - what Eclipse's JUnit runner and Ant write - was
rejected with "no test report Tewip can read", though everything inside it is ordinary JUnit XML.
36 perfectly readable results were thrown away. It now reads them.

Each of the first ten was checked against the report's own totals:

| Runner | What was checked |
| --- | --- |
| Maven Surefire | `failures="2" tests="2"` → 2 read; and a 4-case report with 1 failure → 1 |
| Gradle | two green reports → nothing reported |
| gotestsum | two 25-case green reports → nothing reported |
| cargo-nextest | 3 tests with retries → 6 attempts, which is what a flake needs to be visible |
| NUnit | `failed="11"` of 24 → 11 read |

Two of those looked like disagreements at first and were the checking script's fault, not Tewip's,
which is worth recording: NUnit does not use `<failure>` elements at all but `result="Failed"` on
the test-case, and a runner that retries records several attempts of one test, which Tewip keeps
separately on purpose.

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
- Engineering-quality view (senior / principal engineers): recurring root-cause patterns, flakiness hotspots by component, a quarantine shortlist naming the flaky tests that cost the most CI time (added 2026-09-17), and test-design debt (hard waits, brittle selectors) ranked by cost
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
> Status 2026-09-17 (later): rules-5 reads Playwright's strict-mode errors, which list every element a locator matched. On the fresh set drift rose to 16/23 (70%, target 80% still missed), real bugs called drift fell to 3/29, and 15 real drift failures are now auto-fix eligible with 0 wrong; each suggested locator equals the developers' own fix. Autonomy on real data is no longer 0, but these gains were measured on data seen while designing the rule. On an unseen window (Aug 27–31, 335 labels, 97.6%) the rule made no false drift calls, but that window had no drift cases to confirm recall.
> Status 2026-09-17 (end of day): on the fresh set drift is 16/20 = 80% (70% on the pre-correction labels), real bugs called drift 1/29, and 15 real drift failures are auto-fix eligible with 0 wrong, each suggesting the developers' own fix. Two unseen Gutenberg windows were harvested and labelled after the pipeline was frozen: Aug 27–31 (335 labels) 97.9%, and Aug 20–26 (473 labels) 86.3% with drift 3/3. In both weeks the agent would have made 0 automatic changes, so autonomy on real data is demonstrated but still rare. A weekly workflow now re-runs the whole check by itself.
> Status 2026-09-18: measured on nine real datasets from five public projects (1,800+ labelled failures): dev 96.0%, held-out 85.5%, fresh 93.0% with drift 16/20, two windows harvested after the code was frozen 97.9% and 86.0%, Supabase 99.7%, JupyterLab 90.2%, LXD UI 91.3%, Penpot 5/5. Auto-fix would have fired on 14 real drift failures with 0 wrong, each suggesting the locator the developers themselves wrote. The agent now learns from people (`/triage CATEGORY #n reason` under its own comment, proven live in the sandbox), reports what each run costs, caps its own spend, and re-runs the whole measurement weekly by itself. Known: three runs of identical code score 142-144 of 166 on the held-out set, so differences of one or two cases are sampling noise, not results.

Applies to LOCATOR_DRIFT only:
Pull candidate elements from the DOM snapshot → rank by similarity → generate a new locator → re-run that single test locally → only generate a PR if it passes; discard otherwise.

Phase metric: auto-fix success rate, plus false-positive rate (incorrect fixes must be near zero).

> Direction changed 2026-09-23 at the owner's request: **Tewip may write application feature code**,
> not only tests. The rule that replaces "never touches application code" is the one that made the
> rest of Tewip trustworthy, applied to a harder job: **code is only kept when it is proved.** A
> change to application code survives only if a test that failed now passes, every test that was
> passing still passes, and the change is small and local - and where there is no such test yet,
> Tewip writes the test first and proves that the test fails without the change. Nothing is
> committed, nothing is merged, and a change that cannot be proved is offered as an explanation
> instead. The old promise was "it cannot touch your code"; the new one is "it cannot change your
> code without showing you it works", which is what the owner is buying and what keeps the agent
> safe to install.

> Direction changed 2026-09-19 at the owner's request: Tewip grows from failure triage into a full software-quality agent covering the whole testing and security lifecycle. It is built on top of general models instead of competing with general coding agents, and every output is verified. Application feature code stays with general coding agents, so Tewip keeps its promise never to edit application code.

### Phase 6: Test Plans (`tewip plan`) (BUILT — measured: 8 of 9 judgeable bugs had a scenario naming them, see the caveats)
From a feature description, a pull request's diff, and the running app's pages, write a test plan: scope, risks, scenarios with priorities, which test types apply (functional, accessibility, security, performance) and which to automate. Grounded in facts Tewip reads, never invented: the changed files, the tests that already exist, the pages as they are.

Phase metric: on real pull requests with later-found bugs, the share of those bugs whose scenario the plan named before the bug was found. Until that data exists, plans are shown as drafts.

Status (2026-09-23): **the data does exist in public, and this is now measured.** A pull request
with a later-found bug is a merged pull request plus a later commit saying it fixes a regression
that one introduced. 18 such pairs were harvested from 18 repositories. For each, the repository
was fetched at the pull request's own head and a plan written from `base...head` - exactly what a
reviewer saw, with no knowledge of the bug, which came later.

**8 of the 9 pairs that could be judged had a scenario naming the bug (88.9%).**

| Repository | The bug found later | The scenario that named it |
| --- | --- | --- |
| matrix-org/complement#872 | a timestamp guard was missing on one side of `timeBeforeEventA` | JTDE-001, and the JTDE-003 soak fails on the merged code |
| Try/OpenGothic#980 | the cursor stopped being restored to an arrow in windowed mode | CURSOR-002, CURSOR-004 |
| NLnetLabs/domain#719 | query-slot allocation reused slots before the cursor | NW-008, NW-011 |
| jrpie/launcher#331 | theme changes no longer applied without restarting the app | TP-013 |
| Huber-group-EMBL/rhdf5#242 | the `NA_character_` deprecation warning stopped firing | S4 |
| simonellefsen/budbringer#13 | roads sank too far into the planet surface | S3, S13 |
| Manojalam/Manojalam#71 | petal geometry broke at three slots | RF-001, RF-002 |
| qte77/gha-runner-gui-kit#4 | an accidental `macos-26` runner bump | MACOS-WF-001, MACOS-WF-002 |

Two of those are worth singling out. `domain#719` was titled "Resolve nightly warnings", and the
plan still noticed a behaviour change hidden inside the cleanup. `gha-runner-gui-kit#4` was about
Xvfb on Linux, and the plan wrote a scenario for the macOS runner label that had been changed in
the same pull request - which is the change that was later reverted.

**The miss** was `budget-mvp#16`, and it is the more interesting result. That pull request made an
indicator's freshness depend on a reference date; it was reverted because a frozen interest rate
keeps an old reference date while the briefing is still fresh. The plan tested the change as
intended and would have passed. When a pull request's *intention* is wrong, a plan grounded in that
intention validates it rather than questioning it. Nothing in the current design would catch that.

**What the miss led to (built the same day).** The blind spot is not specific to plans: every layer
of Tewip reads the change's own description as the specification. The things that assumption can be
checked against are the decisions the project already made, so `tewip review` now reports two kinds.
**The checks a change renegotiates**: each assertion the diff rewrites, withdraws or renames, with
the old text beside the new one - on `budget-mvp#16` it shows five rewritten freshness expectations
and a crypto-window test renamed into something unrelated. And **the decisions it alters outside the
tests**: a guard that refused something, a value other code falls back on, a limit, a version or
runner pinned on purpose. Both read the diff only - no model, no network - and both ask rather than
judge.

**Neither is a predictor of regressions, and the first version of this entry implied otherwise.**
"It fired, and that pull request was reverted" is worthless on a corpus where every pull request was
reverted by construction. So a control set was harvested: 30 ordinary merged pull requests from the
same repositories, excluding any that a later commit blames for a regression.

| | 14 pull requests that caused a regression | 30 ordinary merged pull requests |
| --- | --- | --- |
| checks renegotiated | 2 (14%) | 3 (10%) |
| decisions altered | 3 (21%) | 7 (23%) |
| either spoke up | 4 (29%) | 9 (30%) |

The rates are the same, so a change that alters an agreement is **not** more likely to be broken.
What the checks do is put the alterations in front of a person: across the ordinary set they
surfaced 23, including a deleted `raise SystemExit` guard, a semaphore dropped from 4 to 1, and a CI
runner image moved. That is worth a line in a review; a claim to predict bugs would not have been.

Measuring the control set paid for itself twice over. It showed `className="min-w-0"` becoming
`min-w-[9rem]` being reported as a limit, so markup is now excluded, and that `MAX_RETRIES` matched
no limit word at all, because an underscore is a word character - identifiers are now split before
matching.

**Caveats, all of them.** 9 of the 18 pairs could not be judged: 4 repositories were too large to
fetch here (vscode at 1.5 GB, dolphin at 560 MB, and two others), and in 5 the later commit was a
revert that never said what broke - judging those would have been guessing, and guessing would have
flattered the plan. Nine judged pairs is a small sample. The judging was done by Claude, not by the
projects' own engineers, against criteria written down before any result was read: a hit needs a
scenario that would fail when run against the merged pull request, a risk or an open question alone
is not enough. "Would fail" is a reading of the scenario against the fix, not an executed test run,
though for complement#872 it was checked line by line against the fix's own diff. The corpus skews
small: 5 of the 8 hits are established projects (complement, OpenGothic, domain, launcher, rhdf5),
the rest are small ones.

Two faults in the harness were found and fixed before any number was taken. The first extractor
read the pull request number out of "Merge pull request #56 from ...", which is the *revert's* own
number, so ten pairs pointed at the wrong pull request. And the first diff was the merge commit
against its parent, which for a squashed merge is only a version bump - the plan said so itself
("the diff only changes DESCRIPTION from 2.57.12 to 2.57.13"), which is how it was caught.

### Phase 7: Test Writing (`tewip write`) (BUILT — measured on three real projects, see status)
Write automated tests for a scenario (Playwright first, then pytest and Jest), using locators read from the real page. Run each one; keep it only if it passes against the working app. Repair a failing draft a bounded number of times from the actual error, then give up and say so.

Phase metric: the share of kept tests that fail when the behaviour they check is broken on purpose (mutation check), plus the share of drafts kept. A test that cannot fail is worse than no test.

Status (2026-09-19). Datasets: three real projects, with scenarios from Tewip's own plans (not from later-found bugs): Til-AI library search (Playwright, one real app, still under development), unjs/ufo query helpers (Vitest, a public library) and python-humanize naturalsize/intcomma (pytest, a public library). Writing model gpt-5.5.

- Drafts kept: Til-AI 9 of 10, ufo 8 of 10, humanize 9 of 9 (after rerunning, from the cache, drafts first dropped by since-fixed rules for placing the deliberate break). Together 26 of 29 (90%).
- Mutation check: every kept test failed when its main check was broken, and no reliably passing draft survived the break, so on this data the check has not yet caught a weak test (it does catch one built on purpose). 2 drafts were dropped unproven because the break could not be placed; the third draft not kept was the false alarm below. The break is chosen by the model, which is weaker than independent mutation of the app.
- False alarms: 1 "possible bug" on ufo contradicted behaviour the code documents; plan and write now read the code under test, and a possible bug must quote the run's real output.
- Model comparison on Til-AI, same 10 scenarios and prompt: gpt-5.5 kept 9 for $1.53 ($0.17 per kept test); GPT-5.6-terra kept 5 for $0.58 ($0.12 per kept test) and raised 2 unfounded possible bugs. gpt-5.5 stays the default.
- Cost: about $0.50 to $1.50 per plan-and-write of 10 scenarios; reruns of unchanged drafts cost nothing.
- Mutation against the code under test (2026-09-22, opt-in `--mutate-source`, unit frameworks only):
  measured on a test Tewip itself wrote for unjs/ufo and kept. StrykerJS made 470 changes to
  `src/utils.ts`; 429 were in code the test never runs, and of the 41 it did exercise the test
  noticed **3**. So the deliberate-break check, which this test passed, is much weaker than real
  mutation: it proves the assertion matters, not that the test would catch a change in the code.
  The run took 12 seconds narrowed to one file and one test. Reported as counts, never as a
  mutation-score percentage (Papadakis et al., ICSE 2018: that correlation is weak once suite size
  is controlled).

### Phase 8: Broader Verified Fixes (`tewip fix`) — IN PROGRESS
Extend auto-fix beyond renamed selectors to races (replace a fixed wait with a condition) and test-data setup, each verified by re-running, each opened as a PR, never merged.

Status (2026-09-22): the race half is built (`engine/autofix/fix-wait.ts`). It replaces the fixed
wait nearest the failure - `waitForTimeout`, `cy.wait(n)`, `Thread.sleep`, `time.sleep`,
`browser.pause` - either by deleting it, where Playwright and Cypress already wait for the next
step, or by an explicit wait on the element that step acts on. The safety rule that makes it
different from a locator fix: a wrong locator fails every time, so one passing run proves the fix,
but a race passes by luck, so a wait fix is accepted only after **three passes in a row**, and is
refused outright when nothing is asserted after the wait. Not yet measured on real failures: the
labelled datasets have no fixed waits in the failing tests, so the metric needs a project that uses
them.

The test-data half is built too (`engine/autofix/fix-data.ts`). A collision happens because a value
was written into the test by hand, so the fix is to make that value unique per run, in the test's
own language (a template literal, an f-string, or string concatenation), keeping an email a valid
email. Its verification is the strongest of any fix here and costs nothing extra: **running the
fixed test twice**. A value that is not really unique collides with the record its own first run
created, so two passes in a row prove the property the fix is for, rather than merely suggesting it.

It refuses more often than it fixes, on purpose. Postgres usually names only the constraint
("duplicate key value violates unique constraint \"pg_extension_name_index\"", which is the real
message from Supabase CI in the labelled data) and never prints the value; changing a test's data on
a guess could quietly change what the test checks. It also refuses when the value comes from a
fixture or a factory rather than the test file.

Status (2026-09-23): **the race fix is measured on real failures for the first time.** The note
above said this needed "a project that uses fixed waits". It did not: 60 real commits were
harvested from 47 public repositories in which a developer removed exactly one fixed wait from a
test. Each is a labelled example - the file before the commit is the input, and what the developer
wrote instead is the answer.

| | before | after |
| --- | --- | --- |
| Proposals that contain the developer's own change | 16 of 43 (37%) | **19 of 25 (76%)** |
| Proposals with a fallback if the first is not proved | 0 of 43 | 9 of 25 |
| Refused | 30 of 60 | 35 of 60 |

It now proposes less and is right far more often. Four defects were found, each invisible to a
synthetic test and each now covered by one:

- **A wait with a trailing comment was not seen as a wait.** `cy.wait(500); // eslint-disable-line`
  is written precisely *because* the line is a fixed wait. This alone refused 15 of the 60.
- **`waitForTimeout(3_000)` was not seen either**, because numeric separators are ordinary
  JavaScript that the pattern did not allow, nor was the hand-rolled
  `await new Promise(resolve => setTimeout(resolve, 500))`.
- **Cypress assertions did not count as checking anything.** The rule that a fix is refused unless
  something is asserted after it looked only for `expect(`; Cypress asserts with
  `cy.get(...).should(...)`, so six real Cypress fixes were refused with the wrong reason.
- **The fallback never fired.** Tewip offered a second option in 0 of 43 proposals, so in practice
  it could only ever say "delete the wait", and disagreed with the developer 27 times.

The last one uncovered a safety hole, which is the real result here: deleting a fixed wait is only
safe when the **next** step waits by itself. `await expect(locator).toBeVisible()` retries until it
passes, so the wait in front of it is pure delay - but `const url = page.url()`, `.count()` and
`if (await x.isEnabled())` read a value once and never retry, and those were common in the real
commits. Deleting the wait there removes the only thing making the read reliable, and because a race
passes by luck, even three passing runs would not reliably catch it. Tewip now offers deletion only
in front of a step that retries, and otherwise must name something to wait for or refuse.

The refusals were read one by one, and they are the right answer rather than a shrug: where Tewip
refuses, the developer typically waited for something Tewip cannot invent - one replaced the wait
with `await page.waitForURL(/\/(auth|sign)/)`, another with a wait for the text `Mode: Command`.

The **test-data half is now measured too**, in two parts.

First, on the real thing: the labelled datasets contain 6 genuine collision failures, all from
Supabase CI, and every one names only the constraint (`pg_extension_name_index`) and never the
value. Tewip refused all 6 with "the error does not print the value that already existed, so there
is nothing safe to make unique" - which is the correct answer, and the reason this fix refuses more
often than it fires.

Second, on 20 real commits from 18 public repositories in which a developer made a hard-coded test
value unique. **All 12 proposals make the value unique per run** - 5 by the same mechanism the
developer chose, 7 by a different but equally valid one (a timestamp where they used a uuid). The
other 8 are refusals, each with a reason that holds up when the file is read.

Two safety defects came out of it, both now tested:

- **It rewrote a value the test was checking.** `findLiteral` returns every place a value is
  written and the fix took the first - but a value that collides in a database is very often also a
  value the test asserts on, and in real code the assertion often comes first. That is the worst
  outcome this phase can produce: the collision stays, the assertion stops checking what it did,
  and the test passes for the wrong reason.
- **A value that is both created and checked cannot be fixed by this fix at all.** The commonest
  real shape is `name: "Secondi"` and, five lines later, `expect(body.data.name).toBe("Secondi")`.
  Making the data unique leaves the assertion looking for the old value, so both have to change
  together - which is a bigger change than "make this one literal unique", and now a refusal that
  says exactly that.

It now prefers the occurrence that creates a record, never touches one that is only checked, never
touches a value that names an element (`getByRole('button', { name: 'Submit' })` reads like data to
a pattern but is a locator), and refuses where several places create with the same value, because
making one unique would break the link between them.

**The gates themselves are now proved by running tests, not by reading proposals** (2026-09-23).
Everything above compares what Tewip *suggests* with what a developer did, which leaves the claim
that matters untested: a fix is kept only when re-running the test proves it, and otherwise the file
goes back exactly as it was. `engine/test/fix-gate.integration.test.ts` exercises that end to end
with real files and a real `node --test` per attempt, so it runs in CI from now on:

- a redundant fixed wait is removed **only after three real runs pass**, and the assertion the test
  exists for is still there afterwards;
- a wait that is load-bearing is **not** removed - the test fails, and the file on disk is
  byte-for-byte what it was;
- a genuine collision (a record keyed by a literal, so the second run hits the first run's leftover)
  is fixed and then **passes twice in a row**, which is the property two passes exist to prove; the
  test can then be run again and again.

Running them found two faults that reading proposals never would. `assert.equal(...)` did not count
as checking anything - the rule looked for `expect(`, `.should(` and a bare `assert ` - so Tewip
would have refused to fix the commonest shape of JavaScript unit test with the wrong reason. And a
next step that is itself a wait (`await waitFor(() => ready)`) was only recognised inside Playwright
and Cypress, though it makes a fixed sleep redundant in any stack. Both are fixed, and the wait
fix's agreement with real developers rose from 19 of 25 proposals to 19 of 26.

Honest limits: the numbers above measure the **proposal**, not the proof. Running 47 unrelated projects'
end-to-end suites is out of reach here, so the three-passes-in-a-row gate was stubbed, and a
proposal counted as agreeing when it contains the change the developer made. For the test-data
half, the failure message was reconstructed in Postgres's own wording around the literal the
developer changed, which hands Tewip the value: what is measured there is what it does with a value
it has been given, not whether it can pull one out of a log. The 6 real Supabase collisions are the
only part of that measurement where both the failure and the file are real.

Phase metric: as Phase 5: success rate and false-fix rate, with false fixes near zero.

### Phase 9: Security Testing (`tewip secure`) (BUILT — secrets, dependencies and a baseline web check, each measured)
Run established scanners (dependency audit, secret scanning, a baseline web scan) and apply Tewip's triage to their findings: real risk, false positive, or accepted, with evidence and a next step, and the same learning from corrections.

Phase metric: precision of "real risk" on labelled findings; noise removed without hiding real issues.

Status (2026-09-23). `tewip secure` runs what a project already has - `npm audit`, `pip-audit`,
`osv-scanner` - plus Tewip's own offline secret scan, and then does the part scanners do not: decide
which findings matter. No model is called, so it costs nothing, and it always prints what was **not**
checked, because "no real risk found" is a statement about the checks that ran and nothing more.

Four verdicts, each with evidence a person can check:

- **real-risk**: a credential that is committed, or a vulnerable package this project imports;
- **not-reachable**: true of the repository but not of what it runs - a development dependency, a
  package nothing imports, or a secret in a file git does not track;
- **noise**: a shape with no credential behind it (Amazon's own `AKIAIOSFODNN7EXAMPLE` is in their
  documentation), listed rather than hidden;
- **accepted**: a person already judged it, in `.tewip/security-accepted.txt`. Tewip never writes
  that file itself.

**A credential is located, never printed** - in the report, in CI, anywhere. The evidence line shows
the first two characters and dots.

Measured on a labelled corpus Tewip did not write: the validation samples the gitleaks project keeps
beside each of its detection rules, for the credential kinds Tewip claims to cover, cleaned of the
Go code and rule identifiers that sit in the same files.

- **50 of 54 real credentials found**, and 2 of 5 look-alikes wrongly reported. The look-alike set
  is small enough that the second number is weak evidence; it is reported as it is rather than
  dressed up.
- Four defects came out of that corpus and are fixed: a key ending in "-" was missed because a word
  boundary never matches there; `sk-ant-...` was reported twice, as OpenAI's and as Anthropic's; a
  Stripe **production** restricted key (`rk_prod_`) was missed while the live form was caught; and a
  password inside an http URL was not looked for at all.
- The four still missed are deliberate or unusable: an unsigned JWT (`alg: none`) and a JWE fragment
  are not credentials, a truncated PyPI prefix is not a sample, and a Stripe **test** key is not a
  risk.

**Precision on real code, and a false negative that mattered** (2026-09-23). The recall number
above came from a labelled corpus, but the look-alike set was only five, so how often the scan cries
wolf on ordinary code was untested. It was run on five real public repositories - croner, sinatra,
piscina, humanize and a PHP library - and reported **nothing at all** on any of them. To be sure
that silence meant something rather than nothing, credentials were planted: it found them, and
correctly ignored one planted inside `node_modules`.

That test exposed the opposite fault, which is worse in a security tool. A realistic AWS key in
`src/config-sample.js` was dismissed as **noise**, "nothing: this is not a credential", while the
identical key in `src/settings.js` was reported as critical. The filename alone decided it - and a
working key pasted into an example file is one of the commonest ways credentials leak.

A filename is now the weakest evidence there is. Only the **value** or the line around it can make
something noise; a credible value in a template or documentation file is reported as *real, but not
reachable here*, at medium severity, with "check whether this was ever a working credential; if it
was, rotate it". Amazon's own `AKIAIOSFODNN7EXAMPLE` in the same file stays noise, because the value
says so itself. The five real repositories still report nothing.

**The dependency half, against real advisories** (2026-09-23). The audit triage had only met
scanner output written for this project's own tests. Run on a real Node project carrying three
packages with real published advisories - lodash imported in code, minimist declared but unused,
marked a development dependency - the verdicts were right and **the evidence behind two of them was
false**:

- Tewip said "no fixed version is published yet: watch the advisory and consider replacing the
  package" about all three. `npm audit` had answered `fixAvailable: true` for every one of them:
  a single `npm audit fix` resolves all three. Tewip only read the form of that field that names a
  version, and treated the plain `true` as "no fix".
- It said "nothing in this project imports minimist: it is pulled in by another package" about a
  package the project **declares itself**. npm reports `isDirect` and Tewip ignored it.

Both are now read from the scanner's own answer: a fix it knows of without a version becomes
"a fix is available: run `npm audit fix`", and a declared-but-unimported package is described as
exactly that, with "remove it if nothing uses it any more" instead of an unhelpful `npm why`. For a
tool whose whole promise is evidence a person can check, wrong evidence is worse than no evidence,
which is why these count as defects rather than wording.

**A scanner that could not run is not a scanner that found nothing** (2026-09-23). This command's
stated promise is that it always says what was *not* checked, because "no real risk found" is a
statement about the checks that ran and nothing else. It was breaking that promise in two ways,
both found by running it on real projects:

- **No lockfile.** `npm audit` answers `{"error":{"code":"ENOLOCK"}}` and exits 0. Tewip read an
  empty result and printed "Checked: npm audit. 0 need someone now" about a project that declared a
  vulnerable package.
- **A registry that will not answer.** A different shape: the error fields come back empty and the
  reason sits in `message`. Reading the summary with `??` kept the empty string, so an unreachable
  registry also passed for a clean audit - on the project with three published advisories.

Both now appear under **Not checked**, with npm's own words and, for the lockfile case, the command
that fixes it. A clean bill of health that was never earned is worse than no report at all, and all
three states - ran clean, could not run, found something - are tests now.

**The web check against a real running application** (2026-09-23). A real Express server was run
here twice: once serving its own directory the way a static file server does, once configured as
its documentation says, with helmet and a public folder. Misconfigured, Tewip found four things and
every one was true - the served `.env` (critical, and confirmed by reading the file's real contents
rather than a 200 alone), no Content-Security-Policy, no `X-Content-Type-Options`, and a page that
can be framed. Hardened, the same check found **nothing**. HSTS was correctly not mentioned at all,
because the server was http. This is the first outside input that behaved correctly on first
contact.

It did, however, say two contradictory things in one report. The web check: the served `.env` makes
its keys public, critical. The secret scan, about a credential *inside that same file*: "git does
not track .env, so this never left the machine", low. Each is right from where it stands, and
together they are misleading. A secret in a file the application serves has left the machine by the
most direct route there is, so the two checks are now reconciled: that credential is reported as
critical, "the running application serves /.env to anyone who asks", with "rotate it now" instead of
"keep it in .gitignore". A finding a person has already accepted is never overruled this way.

**The baseline web check** (`tewip secure --url http://localhost:3000`) was added the same day. It
asks for the page the way a browser does and reports what the response verifiably shows: missing
Content-Security-Policy, X-Content-Type-Options or Referrer-Policy, a page that can be framed, a
version-announcing Server header, cookies without HttpOnly/Secure/SameSite, and the handful of files
that must never be served (.env, .git/config, AWS credentials) - and those only when the answer
really contains the file, not merely a 200.

What it deliberately does not do: no injection payloads, no fuzzing, no brute force, no attempt to
get past a login. For the deep scan, teams already have OWASP ZAP, so Tewip prints the exact ZAP
command and triages ZAP's own report (`--zap-report zap.json`) instead of pretending to be it.
**An address that is not this machine is refused** unless the person says `--i-am-authorised`:
scanning a system you do not run is not Tewip's decision to make.

Measured two ways:

- On two local applications, one served the way a rushed project serves things and one served
  carefully: **8 of 8 planted weaknesses found in 5 requests, and nothing at all reported about the
  careful one**. That is a controlled application, not a product metric - it measures the checks.
- On four real public homepages, one ordinary GET each, headers only, no path probing: what Tewip
  reported matched the headers those sites really send, every time. MDN, which sets all five, got
  nothing reported; python.org and nodejs.org got exactly the headers they are missing.
- One finding was softened by that real run: GitHub's analytics cookie `_octo` has no HttpOnly by
  design, and calling that "high" is how a security report gets ignored. A cookie is now weighed by
  whether its name says it carries a session.

### More runners: Robot Framework, JMeter, k6 (BUILT 2026-09-23)

Robot Framework writes output.xml by default, JMeter writes .jtl, and k6 writes a JSON summary -
none of them JUnit. All three are read now, and each was checked against real reports published in
public repositories rather than against examples written here. That found three defects before
release: Robot's timestamp (`20180303 09:46:00.211`) is not a date and threw when handed to one;
k6 keeps its numbers under `values` in every recent version; and a JMeter sample that returns 200
but fails an assertion was being reported as "mostly 200", which reads as nonsense.

A performance run does not fail test by test, so the shape is different on purpose: a JMeter report
becomes one record per request label ("4 of 5 requests failed, an assertion failed (4 times,
response 200): The operation lasted too long"), and a k6 run becomes one record per crossed
threshold, carrying the measurement that crossed it.

Appium and Selenium were asked for and deliberately need no importer: those suites report through
Mocha, pytest or JUnit, which Tewip already reads, and their own error messages are already
understood by the device and driver readers. An "Appium importer" would be a label on something
that already works.

A test now also guards the repository against stray control characters in source, after a shell
heredoc turned an escape into a real backspace three times in one day - each time silently stopping
a regular expression from matching, and each time found only by measuring against real data.

### Selector fixes for Cypress, Selenium and WebdriverIO (BUILT 2026-09-23, at the owner's request)

Playwright's traces tell Tewip what was on the page, which is how a drifted locator is matched
against real elements. Cypress and Selenium give it none of that - a JUnit report carries only
"Expected to find element: '#submit-btn', but never found it". Inventing a replacement from that
is exactly the guess this project exists not to make, which is why the roadmap called this a
separate, deliberate decision.

The answer is that the repository knows. If a test looks for `#submit-btn` and the application now
renders `id="submit-button"`, then **the commit that renamed it says so**, and if the commit cannot
be found, the current source can still show that the old name is gone and a very similar one is
there. Both are evidence a reviewer can check, in a way a page snapshot never was - and the fix is
still only kept when the test passes afterwards and the file is otherwise untouched.

Three refusals, each a test: a positional selector (`div > span:nth-child(2)`) is **not
identifiable**, because there is nothing in the source to compare it against and a person should
look at the page; when nothing in the history or the source resembles the old name, Tewip says so
rather than inventing a selector; and a selector that lives in a page object rather than in the test
is named, not edited blindly.

Selenium's own way of printing a selector (`css selector=#submit-btn`, `id=submit-btn`) is read, and
the replacement is written back in the form the test actually uses.

### Writing feature code (`tewip build`) (BUILT 2026-09-23, at the owner's request)

The promise that replaces "it never touches application code" is harder and better: **it cannot
change your code without showing you it works.** The order is the product:

1. Tewip writes the test for the feature **first**, and runs it. **It must fail.** A test that
   passes before the feature exists is testing nothing, and this single check is what stops a model
   from writing code that agrees with itself.
2. It reads what is already failing in the project, so the feature is never blamed for it.
3. It writes the smallest code that makes that test pass, in files it is allowed to touch - never a
   test, never configuration, never a lockfile, never anything outside the project.
4. It keeps the work only when the new test passes **and** nothing that was passing has started to
   fail. Otherwise every file goes back byte for byte, including the test it wrote and any file it
   created. Nothing is ever committed.

Tried end to end on two real public projects, in two languages:

| Project | Feature asked for | Result |
|---|---|---|
| unjs/ufo (TypeScript, Vitest) | `withoutTrailingSlash` should also trim the path of a full URL | **Built**: 4 lines in src/utils.ts, its own test passing, the whole suite still green. 2 model calls, $0.18 |
| python-humanize (Python, pytest) | `naturalsize` should take a `sep` argument | **Built**: 2 lines in src/humanize/filesize.py, suite still green. 2 model calls, $0.10 |

And the refusals, which matter more. Asked for something ufo already does (`joinURL('a','b')`), the
test passed immediately and Tewip kept nothing, saying so after one model call: *"the test passes
without any new code, so it is not testing the feature."* Asked for the Python feature while its
own file-finding was broken, it answered *"the source for naturalsize is not included... I cannot
make a verified edit without guessing"* rather than inventing something - which is exactly the
behaviour that makes this safe, and which also exposed the bug: the files handed to the model came
from similarity alone, so `number.py` and `time.py` arrived instead of `filesize.py`. The file that
**defines** what the feature names is now searched for and sent first.

### Closing the loop: build from a ticket, and propose it as a pull request (BUILT 2026-09-23)

`tewip build --issue PROJ-123` reads the ticket - description and acceptance criteria, from Jira
Cloud, Server, or a public tracker with no account at all - and builds from that instead of from a
sentence typed twice. `--pr` then commits the proved work on a branch of its own and opens a
**draft** pull request describing exactly what was proved and what was not. It never commits to the
branch a person is standing on, never sweeps up files that were not part of the proved work, and
never merges.

**The refusal this exercise bought is the important part.** Handing a real Apache ticket about a
Flink HTTP sink to a URL library, Tewip built an "HTTP sink" into it: 28 lines, its own test
passing, the whole suite green. Every proof rule held - because when Tewip writes **both** the test
and the code, it can always make a self-consistent pair pass, and nothing else in the project
references the invented API, so nothing else can break.

So one more check runs before anything is written: **do the words of this feature mean anything in
this repository?** A project's vocabulary is what is inside its files, not just their names. A
feature that shares almost none of it is refused, for nothing - not one model call is spent:

> almost nothing in this project mentions what that describes (5 of 65 of its words appear here:
> http, error, some, prefer, path). If this is the right repository, say the feature in its own
> words. Tewip can make a test of its own invention pass in any project, and that would prove
> nothing.

Checked both ways: the two features that really were built (a trailing-slash rule in unjs/ufo, a
`sep` argument in python-humanize) and a third (`intcomma` with a custom separator) all pass the
check, while the Flink ticket and a Kubernetes-operator request are both refused. An earlier version
judged by file names alone and refused `naturalsize`, which lives *inside* filesize.py - that was a
false refusal, and false refusals are worse than useless.

### The risk review (`tewip review`) (BUILT 2026-09-23 — coverage measured on 16 real commits)

A coding agent can read a diff. What it cannot say is that the two tests covering your change have
flaked eleven times this month, that this area has had three real bugs since August, and that
nothing at all covers the file you edited. That comes from Tewip's own history, so it costs nothing
and nothing else can produce it.

`tewip review --diff main...HEAD` answers, before anyone reads the diff: which tests reach the
change and **how** they reach it (they import the file, they import the package that exports it, or
their words merely match - said plainly, because "6 tests cover this" is only useful if it is true);
which of those tests have flaked before, so a red run is not blamed on the change; what has gone
wrong in these areas before; what nothing tests at all; and the command that runs the telling tests
first, ordered by which have caught a real bug here.

Measured without anyone's opinion, on 16 real commits from two public projects where the developers
changed source **and** the test that covers it: Tewip was given only the source files and asked
which tests cover them, and the answer was checked against the test file those same developers
touched. **16 of 16 named correctly, 12 of 16 ranked first.**

That measurement found the bug that mattered: 8 of the 16 were missed at first because every test in
a library imports `"../src"` and nothing imports `"../src/utils.ts"`. Following the package's front
door fixed it, and is now a test of its own.

### Not only Jira: Rally, GitHub Issues, Azure Boards and Linear (BUILT 2026-09-23)

Teams do not all live in Jira, so the promises had to stop living in the Jira client. Everything in
Tewip now talks to one small `Tracker` interface - create an item, comment on an item it created,
find what it filed before - and three trackers implement it: **Jira** (Cloud, Server and Data
Center), **Rally** (Broadcom, formerly CA Agile Central, through its Web Services API v2.0) and
**GitHub Issues**, for the many teams whose backlog is simply their repository.

The restraint is enforced above all three, and tested as such: no tracker is ever asked to move an
item through a workflow, assign anyone or close anything, and a test that proves it inspects every
request the three of them make.

Each tracker speaks its own language: Rally files a HierarchicalRequirement where Jira files a
Story, GitHub puts the kind in a label, and a P0 arrives as "Highest" in Jira, "Resolve Immediately"
in Rally and "priority:p0" in GitHub. Tewip picks the tracker from the settings
(`TEWIP_TRACKER=jira|rally|github`, or whichever credentials exist), and GitHub Issues uses the
`gh` CLI login a developer already has, so it needs no new secret.

**Azure DevOps Boards** and **Linear** followed the same day and cost one file each, which was the
point of the interface: Azure wants a work item built from a list of patch operations and finds its
own by a WIQL query on tags; Linear speaks GraphQL, needs its team looked up by key first, and
answers 200 with errors inside the body. Both are wired into the same choice of tracker
(`TEWIP_TRACKER=jira|rally|github|azure|linear`, or simply whichever credentials exist).

Verified: the GitHub Issues reader against a live public repository (50 issues found by label).
Rally, Azure Boards and Linear are written to their published APIs and unit-tested against recorded
shapes, **not yet run against a live instance of any of them** - nobody here has one. Said plainly
rather than implied.

### The flake dossier (`tewip flaky`) (BUILT 2026-09-23 — measured on three real projects)

A flaky-test product counts retries. Tewip already decided, failure by failure, whether each one was
the test being unreliable, the environment being broken or the application being wrong - so it can
answer the question a team actually has on Monday: which tests are wasting our time, how much, and
is it safe to quarantine one. Read from history it already kept, so it costs nothing and runs no
tests.

Three rules, all refusals:

- a test that *mostly* fails is broken, not flaky - hiding it would hide what it is telling you;
- a test whose failures Tewip read as the application being wrong is **never** quarantined;
- quarantine needs several runs, and failures that are mostly the test being unreliable.

`--apply` writes the quarantine line into the test file in the project's own framework
(`test.fixme`, `test.skip`, `@pytest.mark.skip`, `@Disabled`, `[Fact(Skip=...)]`, `t.Skip`), with
the evidence in a comment above it, touching nothing else - and remembers which tests it did, so it
can tell the team when one has stopped failing and should come back. Nobody ever takes a test out of
quarantine; this is the half that does.

Measured on real harvested CI history, with each failure's cause taken from the labelled ground
truth rather than from Tewip's own diagnosis:

| Project | Runs | Tests that failed | Quarantine | Fix, do not hide | CI time that quarantine gives back |
|---|---|---|---|---|---|
| Gutenberg (dev window, ~4 days) | 826 | 316 | 21 | 19 | ~34 min/week |
| Gutenberg (August, ~5 days) | 650 | 157 | 19 | 4 | ~148 min/week |
| Supabase (~7 days) | 623 | 65 | 36 | 3 | ~1,178 min/week |

**In all three, zero quarantine suggestions contained a single real-bug failure.** The clearest
case: one Gutenberg test failed in 161 of 647 runs across 109 different branches - which is the
evidence that it is the test and not anyone's change.

### The LEARN step, everywhere (`tewip correct`) (BUILT 2026-09-23)

A person could already correct a *diagnosis*, by replying under Tewip's own comment in CI. Every
other verdict it gives - quarantine this test, this secret is a real risk, the page has drifted from
the design, this feature does not belong in this repository - had no such path, so the same argument
had to be had again every week.

`tewip correct <kind> "<what>" <verdict> ["why"]` is that path for all of them, and `--list` shows
what the team has decided. Corrections are kept in the project (`.tewip/`), not inside Tewip, so
they belong to the team and travel with the repository. The newest answer wins, so changing your
mind means saying so again rather than editing a file. Every correction records who, when and why,
and what Tewip had said - which makes each one a labelled example for later.

**A correction changes what Tewip says, never what it does on its own.** Deciding a failure is a
real bug does not make it change code; deciding a quarantined test is really broken does not make it
un-quarantine anything. That was the rule for diagnoses and it is the rule for all of them.

Proved end to end on a real report: `tewip correct diagnosis "shop computes the total" TEST_DATA`
turns the next run's answer into *"TEST_DATA, confidence 1.00, source: corrected by a person"*, and
`tewip correct flaky "shop reaches the pricing service" fix-now` turns that test's verdict into
*"Afiyat decided this on 2026-09-23: the service URL is wrong in the config, not flaky (Tewip had
said watch)"*.

Building it found two faults in the existing path, both of which would have made a correction look
accepted and do nothing: it was written one folder above where the engine reads corrections, and the
error shape was stored truncated, so it could never equal the shape the matcher computes. Both are
now tests.

### What the corrections add up to (`tewip learn`) (BUILT 2026-09-23)

`tewip correct` gives one failure the right answer. It does not tell anyone *where Tewip is
systematically wrong*, so a team could keep entering the same correction every week and nothing
would ever change. `tewip learn` reads everything the team has corrected and reports the shapes:
how often Tewip said X when the team said Y, which layer decided those (rules or model), which rule
by name and how many of them it decided, what the failures had in common in their own words, and
three real failures to read. `--labels <file>` writes the corrections out as labelled examples, so a
change to the rules can be measured against them rather than argued about.

Two rules keep it honest, and both are tests:

- **Three of the same shape before it is a pattern.** Below that it says so in as many words -
  "2 corrections turned REAL_BUG into TEST_DATA; that is not yet enough to call it a pattern".
- **It never blames a rule it cannot name.** When one rule decided most of a group it says to go and
  read that rule; when no rule did, it says a rule is *missing* rather than picking one to blame.
  It also reports how many *different* tests a pattern came from, because one flaky test corrected
  six times is one piece of evidence, not six.

**Measured on real labelled data, not on corrections we invented.** On a labelled dataset, every
case where Tewip's diagnosis differs from the human label is exactly the correction a person would
have entered, so the two held-out Gutenberg sets were replayed and their disagreements fed in:

| Dataset | Labelled failures | Disagreements | Largest pattern found |
| --- | --- | --- | --- |
| Gutenberg held-out | 166 | 23 (13.9%) | 7x said REAL_BUG, labelled TIMING, from 4 tests; `locator-drift` decided 4 of 7 |
| Gutenberg August-2 | 473 | 52 (11.0%) | 45x said REAL_BUG, labelled TIMING, from 11 tests; `locator-drift` decided 27 of 45 |

The same top pattern on two independently labelled sets is the finding: the real weakness is
calling a timing failure a real bug, and `locator-drift` is the rule most often behind it. That is
a rule to go and read, which is exactly what this report is for. Note the caveat: these are labels
from the evaluation sets, not corrections typed by a team using Tewip day to day - no team has used
it long enough for that yet.

Building it found a real fault in the first version: it read the rule name out of the evidence text
rather than the `ruleId` the diagnosis already carries, so every group came back "decided by 2
different layers", naming no rule - the least useful thing the report could say. It also printed
the same failure three times when one test had been corrected repeatedly. Both are now tests.

### Acting on what `learn` found, and not shipping it (2026-09-23)

The report's largest finding was tested the same day, and the honest outcome is that **nothing
shipped**. It is written down because a negative result that cost two full measurement sweeps is
worth more than repeating it later.

First, the report itself was wrong about *who* to blame. It read the rule name out of a diagnosis's
evidence, and a rule that **declines** still leaves evidence under its own name - so failures the
model had answered were being blamed on `locator-drift`, a rule that had explicitly said "not
mine". Fixed to use the `ruleId` a rule-decided diagnosis already carries, and tested. With that
corrected, the real finding changed: the largest systematic error is not a wrong rule but a
**missing** one. Of 52 failures called REAL_BUG that people labelled TIMING, 32 were answered by
the model because no rule would take them.

Two fixes were then built and measured, and both were rejected by the data:

1. **A rule reading cross-commit evidence.** `timing-intermittent` counts how often a test flips
   between passing and failing *on its own branch*; on CI where every pull request is its own
   commit, that is always zero, so it never fires. A new rule used "the test also failed on other
   people's commits" instead. In isolation the signal looked decisive: it separated 33 of 52 wrong
   calls from 27 real bugs with no overlap. In the real pipeline it fired 12 times in 2,181
   labelled failures and was **wrong 11 of those**, every one a real bug. The reason is that the
   earlier rules already take the cases this signal explains; what reaches a rule this late is the
   hard remainder. Narrowing it to "failed the same way elsewhere" did not help: the split was by
   dataset, not by threshold - perfect on the two weeks it was tuned on (4/4 and 20/20), harmful on
   the two it was not (11 environment failures broken on one, 8 on the other). That is what
   held-out sets are for.
2. **Telling the model what the facts mean.** The root cause of (1) is that failing the same way
   across unrelated commits is equally the signature of a flaky test *and* of a broken environment,
   so a rule that overrules can only trade timing mistakes for environment ones. The model can
   read the error and tell those apart, so the history summary it already receives was changed to
   add the interpretation rather than a verdict. Re-measured on all six real sets: dev -1 case,
   held-out -2, fresh -2, August 0, August-2 +2, Supabase 0. Every delta is inside the +-1-per-150
   sampling noise the evaluator itself reports. No measured gain, so it was reverted rather than
   kept as "probably better".

Accuracy on the six real sets is therefore unchanged, and deliberately so: 96.4%, 86.1%, 93.4%,
97.9%, 89.0%, 99.7%. What was kept is the attribution fix in `tewip learn`, which changes what the
report tells a person to go and read.

### Beyond Phase 5: Continuous Improvement
The agent keeps getting stronger after the last phase, but only in measured steps: every human correction becomes a labelled example (built 2026-09-17: people reply `/triage CATEGORY #n reason` under the agent's own comment, and it uses their answer for that failure from then on), misclassifications drive new rules or prompt changes, accuracy and autonomy rate are re-measured on real data after every change. A change that lowers a measured number is not kept as it is: either its cause is fixed and everything is re-measured, or it is reverted. (Rule reworded on 2026-09-17 at the owner's request, so a regression leads to a root-cause fix rather than stopping.)

## Beyond diagnosis: what makes Tewip the tool a department opens every day

Phases 1 to 9 make Tewip the best answer to "why did this fail, and what do I do about it". Phases
10 to 14 are what turn that into daily use across a whole IT department: the work items people live
in, the designs they build from, the code they fix, and the places they already are. Every one of
them keeps the rule that makes Tewip worth trusting - **it says only what it can show** - and each
names what it deliberately will not do, because a tool that will not lie to you is the product.

### Phase 10: The Work Item Loop (`tewip jira`) (BUILT — all four directions; reading measured on 150 real tickets)

Tewip already writes plans and verified tests. What stops a team using it daily is that its output
lives in a folder while their work lives in Jira. This closes that loop in both directions:

- **In:** `tewip plan --issue PROJ-123` reads the ticket (description, acceptance criteria, linked
  designs, comments) and plans from it, as it already plans from code and pages.
- **Out:** the plan's scenarios become real work items — a test-case issue per scenario, linked to
  the story, with the priority and the "already covered by" evidence Tewip found.
- **Back:** a failure Tewip diagnoses as a real bug opens (or updates) a bug issue with its
  evidence, the run link, and the test that caught it; a failure it diagnoses as environment does
  not, which is the whole point.
- **Test management:** the same scenarios export to Xray and Zephyr, which is where QA departments
  actually keep test cases.

Phase metric: the share of created work items a person keeps without editing the substance (title,
steps, expected result), measured on a real backlog. A ticket a human rewrites was noise.

Refused on purpose: Tewip never moves a ticket through a workflow, never assigns people, and never
closes anything. Writing is a suggestion; the board is the team's.

Status (2026-09-23). The half of this phase that does not need someone's board - reading a real
ticket - is now measured, because it can be: two large public trackers (Apache's and Jenkins') are
readable by anyone.

- **Jira Server and Data Center are supported**, not only Cloud. Most companies run the first kind,
  and it speaks a different API version and stores descriptions as wiki markup rather than as a
  document tree. Tewip guesses the version from the address and corrects itself from the answer.
- **A public tracker needs no account at all.** With only `TEWIP_JIRA_URL`, Tewip reads; writing
  still needs a token. `tewip plan --issue FLINK-40699` against Apache's live tracker reads the
  ticket, finds its acceptance criteria and plans from them, with no credentials anywhere.
- Measured on **150 real tickets** from those two trackers: descriptions that came out as readable
  text went from **75 of 150 to 149 of 150**, and acceptance-criteria sections written by a human
  went from **11 of 61 to 61 of 61**, with one false positive among the 89 tickets that had none.
  The heading styles came from the corpus, not from guessing: `h2. Acceptance Criteria`,
  `h1. +*Acceptance criteria*+`, `h3. Suggested acceptance criteria`, `Definition of Done`.

The other two directions were built on 2026-09-23:

- **Bugs back.** `tewip bugs <report> --project PROJ` files a bug for each failure Tewip diagnosed
  as a real bug at 0.80 or above, with the error, the evidence, the run link and the test that
  caught it - and deliberately files nothing for a flaky test, an environment problem or test data.
  The same failure is never filed twice: a second sighting is a short note on the ticket Tewip
  itself opened, found by its own label. Nothing is created without `--create`, and **a dry run
  needs no account at all**, because "what would it file?" is the question people ask first.
- **Test management.** `tewip jira <plan.json> --export xray|zephyr` writes the plan's scenarios as
  the CSV Xray or Zephyr Scale imports, one row per step, with priority in the importer's own words
  and the "already covered by" evidence in the description. No account, no network: importing stays
  a person's step, and both tools let them map the columns.

Still not measured: the phase metric itself - the share of created work items a person keeps without
editing - which needs a real backlog and a real person.

### Phase 11: Design to Checks (`tewip design`) (BUILT — measured on four real design/page pairs, see status)

A design in Figma is a specification nobody tests against. Tewip reads a Figma file through its API
and turns each frame into checks it can actually verify against the running page:

- the accessible names and roles the design implies exist;
- the text the design specifies, present and spelled the same;
- **design drift**: the implemented page's accessibility snapshot compared to the design's frame,
  reported as "the design says X, the page says Y", with no guessing about pixels.

Phase metric: on a real project, the share of reported drifts a designer or developer agrees is a
genuine difference. Anything below usefulness gets dropped rather than tuned into noise.

Refused on purpose: Tewip does not generate application components from a design. Component code is
feature code, which belongs to the general coding agents and to people, and generating it would
break the promise that makes Tewip safe to install.

Status (2026-09-22). `tewip design <figma link | frame.json> --url <page>` is built. It reads a
frame through Figma's REST API (read only, `TEWIP_FIGMA_TOKEN`) or from a saved JSON file, and makes
three kinds of check: the words the design specifies, the controls its layer names imply, and the
page regions its section names imply. No model is called, so a run costs nothing and gives the same
answer twice.

How the naming rules were settled: Figma API dumps from fifteen public repositories (47 frames) were
read with the first version of the reader, which found roles in only twelve places and, in one real
file, turned forty-nine paragraphs into "missing links" because that designer named every text style
"Link inline". Two rules came out of that data — a text layer's name has to *be* a role word, not
merely contain one, and a control's name has to be short enough to be a label — and both are now
tests.

Measured end to end on four real design/page pairs (paulasilvatech/Figma-to-Code-Dev: a Figma export
and the page built from that export, in the same repository), and widened on 2026-09-23 to ask the
harder question as well - not only whether drift is caught, but whether anything else is reported:

- 38 checks across the four pages, and **0 differences reported** on the untouched pages. One false
  positive was found during the first run and fixed: a frame called "Section Header" was read as the
  page's banner, when it is the heading of a section.
- **11 of 11 real drifts caught**, each named correctly: a renamed control, a dropped phrase, a word
  replaced inside a sentence, and a region that stopped being marked up.
- **5 of 5 harmless changes left alone**: a label shouted in capitals, extra spaces and punctuation,
  a button implemented as a link, and a page whose sections were reordered with every word kept. A
  checker that reports those is worse than no checker, because it gets switched off.

Metric caveat, stated plainly: the phase metric asks what share of reported drifts a designer or
developer agrees with, and no designer has judged these. What this measurement shows is narrower —
Tewip does not cry wolf on pages that match their design, and it does notice when they stop
matching. The designer-judged number needs a real project with a real design file.

### Phase 12: Verified Fixes to Application Code (`tewip fix --code`, opt-in) (BUILT — 16 of 16 real bug fixes in two languages, see status)

The hardest and most valuable extension, and the one that must be built last, because it crosses the
line Tewip has kept since Phase 1: it never edits application code.

It stays safe only under a rule with no exceptions: **the failing test is the oracle.** A change to
application code is proposed only when

1. the failure is diagnosed REAL_BUG with high confidence and a person has opted in;
2. the change makes that failing test pass;
3. **every other test in the file's suite still passes** (no green by breaking something else);
4. the change is small and local, and it is opened as a pull request, never merged, never applied
   to a branch on its own.

If any of those cannot be shown, Tewip explains the bug instead of touching the code. That is not a
lesser outcome: an explanation with evidence is what a developer wanted anyway.

Phase metric: false-fix rate on real bugs with known fixes, which must be near zero, and the share
of proposed fixes a reviewer merges unchanged. Measured on public repositories with a failing test
and its real fix (the SWE-bench style construction), never on fixes Tewip invented the test for.

Status (2026-09-23). `tewip fix --code <report>` is built. It never runs unless a person types
`--code`, it takes only failures the engine itself called REAL_BUG at 0.85 or above, and it refuses
to touch tests, configuration, CI files, lockfiles, migrations and anything holding secrets - a
passing test proves nothing about a change to those. A change survives only if it applies exactly
once, adds or removes at most 20 lines, makes the failing test pass, and breaks nothing that was
passing before. Otherwise the file goes back byte for byte and Tewip explains the bug instead.

Measured the way the metric asks, by replaying real bug fixes from public repositories: check out
the commit *before* each fix, bring in only that fix's tests, confirm the real bug reproduces, then
let Tewip try. Writing model gpt-5.5 at medium reasoning.

| Project | Language, runner | Bugs reproduced | Changes proved by the tests | In the file the developers changed |
|---|---|---|---|---|
| unjs/ufo | TypeScript, Vitest | 8 of 8 | **8** | **8 of 8** |
| python-humanize/humanize | Python, pytest | 8 of 8 | **8** | **8 of 8** |

Every one of the sixteen is small: 1 to 16 changed lines, median 4. Read against the developers'
own commits, most do exactly what the developers did (collapse leading slashes, a null-prototype
query object, `round()` instead of truncation, fold a degenerate fraction into the integer part);
a few take a different route to the same behaviour and pass the whole suite. **No wrong fix was
offered**: every change that could not be proved was thrown away and the file restored. Those
judgements are mine against the real commits, not a maintainer's, and the "merged unchanged" half
of the metric still needs real reviewers.

Six faults in Tewip itself were found by these measurements and fixed, which is what the exercise
was for:

1. the prompt sent the file with line numbers, which the model copied into its change, so the change
   matched nothing;
2. the file to change was chosen from what the test imports, which in a one-barrel package is the
   wrong file (now the failing test's own name decides, and it moved `parseQuery` to src/query.ts,
   where the developers fixed it);
3. a runner that never ran the test - a bad flag, a missing module - was read as a failing test;
4. a Windows checkout has CRLF line endings and a model answers in LF, so four correct fixes were
   rejected as "not found in the file";
5. the whole suite was required to be green, so in any project that already has a failing or
   erroring test - here fifteen, from an uninstalled benchmark plugin - every correct fix was
   rejected as "broke others". Now the suite is read once before the change and a fix is blamed only
   for tests that were passing and now fail;
6. the size of a change was measured as the span from the first differing line to the last, which
   called a two-line fix in two places a "fifty-line rewrite" and printed ninety lines of patch for
   a moved block. A real line diff now feeds both the size rule and the patch a person reads.

Still not covered: Java, Go, C# and Ruby are read by the same code paths (their stacks are parsed
and their runners supported) but have not been replayed against real bug fixes.

### Phase 13: Where Teams Already Are (daily use) (BUILT — four outlets; the phase metric needs a real team and four weeks)

Being useful daily is a distribution problem, not a capability one:

- **GitLab CI and Jenkins**, not only GitHub Actions — the engine is already platform-free; only the
  edges (context, comments, history) are GitHub-shaped.
- **Slack and Teams**: the morning digest, and an alert only for what needs a person.
- **A weekly quality note** for leads and architects, written from the history Tewip already keeps.
- **`tewip watch`**: run it beside your tests locally, and get the diagnosis the moment one fails,
  without CI.

Phase metric: a team that installed it is still using it four weeks later. Nothing else measures
"daily".

Status (2026-09-23). All four are built.

- **Any CI, not only GitHub Actions.** `tewip report <report>` reads the facts out of whichever CI
  is running - GitLab CI, Jenkins, CircleCI, Azure Pipelines, Bitbucket, Travis, Drone, or nothing -
  from each platform's own documented variables. It prints the board, writes it to a file, appends
  it to the job summary where the platform has one, and with `--gate` fails the build only on
  failures that are not known flaky or environment noise. Tried end to end as GitLab CI (merge
  request 7) and as Jenkins on the same report: the gate exits 1 with a real bug present and 0
  without.
- **GitLab merge requests.** `engine/ci/gitlab.ts` posts one note and edits that same note on later
  runs, so a long review is not buried under robot comments. It refuses `CI_JOB_TOKEN`, which cannot
  post notes, and asks for a project access token instead. It never approves, merges or resolves.
- **Slack and Teams.** One short message: how many failures, what kinds, and the ones that need a
  person. **It stays silent when nothing needs anyone**, because a tool that posts every green run
  is muted within a week and then useless on the day it matters.
- **`tewip watch`.** Beside your editor: runs your tests when a file changes (`--cmd "npm test"`) or
  watches for new reports, and explains each failure the moment it happens. It finds a report
  whatever the runner called it, by reading the first bytes, and does not mistake pom.xml for one.
- **`tewip note`.** The weekly quality note for a lead, written only from runs Tewip already
  diagnosed: no new model calls, so it is free and cannot re-judge old failures with today's rules.

Not measured: the phase metric itself. "Still using it after four weeks" needs a real team and four
weeks, and no team has installed it yet. What is shown here is that each outlet works.

### Phase 14: Writing for People, Not Only Machines (`tewip spec`) (BUILT — half the metric measured, see status)

Epics, stories and acceptance criteria from a feature description, grounded the way the test plan
already is: in the code that exists, the tests that exist, and the failures this project has had.
The same discipline applies — every claim about what the system already does is checked against the
code, and anything unknown is an open question rather than a confident sentence.

Phase metric: the share of generated acceptance criteria that survive review unchanged, and the
share of "the system already does X" claims that are true.

Refused on purpose: business plans, market analysis and anything Tewip cannot check. A confident
document nobody can verify is the opposite of what this project is for.

Status (2026-09-23). `tewip spec "<feature>"` writes an epic, its user stories and their acceptance
criteria (Given / When / Then), grounded in the same facts the test plan uses: the code, the tests,
the running pages, the change, and this project's failure history. With `--project PROJ` it shows
what it would file in Jira and files it only with `--create`, under the same restraint as the test
cases: never twice, never moved, never assigned, never closed. It is told in its own prompt to write
no estimates, dates, budgets or business cases, because it cannot check them.

The check that matters is enforced in code, not asked of the model: **every claim that the system
already does something must carry a quote from a file Tewip read**, and every distinctive word of
that quote must really be in that file. A claim that fails becomes an open question, so a reader is
asked rather than misled.

Measured on three real projects (unjs/ufo, python-humanize, and Tewip itself), writing model gpt-5.5:

- 15 stories and 49 acceptance criteria.
- 46 claims about what the system already does: **22 kept with a quote a reader can check, 24
  demoted to open questions**. Reading the kept ones against the cited files, each one holds.
- The check is deliberately strict, and several demoted claims were probably true but quoted
  loosely. Asking is the cheaper mistake.

Not measured: the other half of the metric - the share of acceptance criteria that survive review
unchanged - which needs real reviewers on a real backlog.

## Phases 15 to 19: the verification layer (planned 2026-09-26)

> Chosen from what the market is actually short of, not from what is fashionable. Everyone
> generates tests now; the reported problem is that nobody trusts the output. 88% of developers say
> they are not confident deploying AI-generated code and 29% of teams have rolled back a release
> because of an AI error, and researchers have named the cause the **verification gap**: the model
> writes the code, writes the tests that check the code, and in one documented case fabricated
> passing results to hide what it had done. Every rule Tewip already keeps - nothing kept unless
> running it proves it, refuse rather than guess, every claim carries evidence a person can check,
> always say what was *not* checked - is an answer to exactly that. So the strategy is not to chase
> generation. It is to be the layer that proves.
>
> The owner asked for this order on 2026-09-26. Claude's one disagreement is recorded: five real
> users would teach more than phases 17 to 19 together, and publishing to Open VSX should not wait
> for any of this.

### Phase 15: Proof-Carrying Quality (`tewip attest`)

The evidence already exists but is buried in reports. Phase 15 makes it a single artifact attached
to a build: what was checked, how each thing was checked, what passed, what was **refused and why**,
and what was not checked at all. Sealed, machine-readable, and readable by a person who has never
opened CI. Nobody else can ship this, because an attestation is only worth anything from a tool that
refuses honestly, and refusing honestly is the part competitors skip.

Phase metric: a release decision taken from the bundle alone, with nobody opening the CI logs - and
every claim in a bundle traceable to the run that produced it. Nothing may appear in a bundle that
Tewip did not verify itself.

Status (2026-09-26): **built** as `tewip attest`. It gathers one run into a single artifact - the
claims with their evidence and the layer that decided each, what Tewip **refused** to decide and
why, and what it did not check at all - in Markdown for a person and JSON for a build to carry.

Three rules are enforced by tests, and they are the ones that make a bundle mean anything:

- An undecided failure is recorded as a **refusal**, never quietly dropped. The refusals are not a
  footnote; the report says why they are there: a tool that never admits it could not tell cannot
  be trusted about the rest of the page.
- A diagnosis with **no deciding layer** produces no claim, however high its confidence looks.
- When nothing is recorded as unchecked, the bundle says that is **itself worth doubting**, because
  a check that never ran cannot report itself.

Proved on a real third-party project rather than a fixture: humanize's own pytest run, where the
bundle reads "744 test(s) attempted, 15 failed", lists the 15 as ENV with the fixture evidence and
the rule that decided them, and states plainly that no security scan, no passing test and nothing
uncovered by any test is included.

**Sealed, and precise about what that is worth** (2026-09-26). The phase said "signed" and the
first implementation signed nothing, which is exactly the overclaim this project exists not to
make. Every bundle now carries a **digest**, and carries a **signature** when `TEWIP_ATTEST_KEY`
holds an ed25519 private key. `tewip attest --verify <bundle.json> [--key <public.pem>]` checks one
and exits non-zero when it should not be trusted, so a pipeline can gate on it.

The two are deliberately never conflated, in the type, the report and the verifier:

- a **digest** says the content matches the fingerprint recorded inside it - which anyone who edits
  the bundle can recompute, so it shows the file is undamaged, **not** that nobody edited it;
- a **signature** says the holder of a key produced this exact content, and that is only available
  when a key exists.

A bundle with a signature and no key to check it against reports "the signature was not checked"
rather than anything warmer. A key that cannot be used stops the run instead of quietly shipping an
unsigned bundle.

Proved by tampering: a real bundle of 15 claims was signed, verified valid, then had one claim
removed - the edit someone hiding a failure would make - and the verifier answered "Do not trust
this bundle: it has been changed since it was written", exit code 1. The first attempt at that test
was a no-op, because the bundle had no refusals to delete and the "tampering" changed nothing; that
is recorded because a test that cannot fail is worse than no test.

**Proved in live CI, not only locally** (2026-09-26). The Action was re-run in the private
practice repository and the artifact it uploaded contains `attestation.md` and `attestation.json`
beside the role views: a real repository, a real commit (`1b7863b9`), a real run id, and a digest.
Nothing in the sandbox was changed to get it - the workflow already tracks `hmamut39/tewip@main`,
so re-running an existing run was enough.

Reading that live bundle found two things worth fixing, both of the same kind: true statements that
tell a reader nothing. On a run where every test passed it said "0 decided by deterministic rules,
0 sent to the model", and it carried the caveat "anything the rules could not settle is undecided"
about a run where nothing needed settling. A green run now reads as a green run.

The Action also gained an `attest-key` input, because signing existed and CI had no way to use it.
With a key in a secret the bundle a run uploads is signed, and `tewip attest --verify` confirms it -
checked here end to end on a bundle produced by the CI path itself.

**In CI from 2026-09-26.** Every run of the Action now writes `attestation.md` and
`attestation.json` beside the role views, into the artifact it already uploads: no new step, no
input to set, and it appears whether or not anyone knows the command exists. A release decision
should not depend on somebody remembering `tewip attest`.

Running the CI path for real found the bundle claiming "2 decided by deterministic rules" while
listing one of the two under **Refused**. A rule that looked and could not say has not decided
anything; only settled diagnoses are counted now, and a test holds it.

Not yet measured: the phase metric itself, which needs a real release decision made from a bundle
by someone who did not open CI. The bundle now reaches them without being asked for, which is the
part that was in Tewip's hands.

### Phase 16: The Production Loop (incident to proved test)

Tewip stops at CI, which is half a lifecycle. The pattern now standard in agent observability is
that a production trace failing an online scorer becomes an evaluation case, so the suite grows from
real behaviour. The same shape applies to software: **a production incident becomes a failing test,
proved to fail for the incident's reason, added to the suite, and the fix proved against it.** Two
connectors in (Sentry, Datadog, OpenTelemetry) and the existing verified `write` and `fix` out.

Phase metric: on real incidents, the share for which Tewip produces a test that fails before the fix
and passes after it - with a false-reproduction rate near zero, since a test that passes on the
broken code is worse than none.

Status (2026-09-26): **built** as `tewip incident <file>`. It reads a Sentry event, an
OpenTelemetry span or a stack trace someone pasted - deterministically, no model, because reading a
stack trace is parsing - finds the frames belonging to this project, writes a test against that
code, **runs it**, and keeps it only if the judgement is *reproduced*.

The judgement is the phase. Red is not proof:

| What the run did | Verdict | What Tewip does |
| --- | --- | --- |
| fails with the incident's error type and words | reproduced | keeps it |
| fails with the same type, different message | reproduced | keeps it |
| fails its own way (a typo, a wrong expectation) | failed-differently | deletes it, says what each side reported |
| passes | passed | deletes it - "weakening it until it fails would prove nothing" |
| never ran (missing module, syntax error, missing fixture) | never-ran | deletes it, nothing shown either way |

Proved end to end on a real project with a real latent bug - code that assumed an optional field,
with the project's own test green because it only covered the happy path. From a Sentry-shaped
event: Tewip wrote the test, ran it, and it failed with `TypeError: Cannot read properties of
undefined (reading 'amount')`, the same error production reported. One model call, 745 in / 741 out
tokens, **$0.026**. After the one-line fix a developer would make, **both** tests pass - so the
loop closes and the incident is guarded against for good. Given an unrelated incident (a database
that refused connections, in code this project does not contain) it wrote a test, ran it, and
**refused**: "the test fails, but not with the incident's error".

Not measured: the phase metric across many real incidents. That needs a stream of real production
failures from a real service, which is the same thing Phase 13 and the Definition of Success need.

### Phase 17: Retrieval Before Generation (narrow RAG)

The rule that made the diagnosis layer cheap and trustworthy - rules before models - becomes
retrieval before generation. Tewip already owns the corpus worth having: its own measured history of
real failures, diagnoses, corrections and proved fixes. That gets indexed first, so it can answer
"has this happened here before, and what did we decide?" with citations. Only then the project's own
Jira, runbooks and documentation.

Phase metric: the share of answers that cite a real prior record, measured against the question
being answerable at all - and the cost per answer must stay within the current $1.12 per 1,000
failures. A vector database everywhere that loses that economics is a failure, not a feature.

Status (2026-09-26): **built** as `tewip recall "<an error, or a question>"`, and the measurement
settled the design question before any code shipped: **no vector database, no embeddings, no
network, no cost.**

The test was run the way the feature is used - walk a real labelled dataset in order, and at each
failure ask the history *only what came before it*, then check whether what came back carried the
same human label. The baseline to beat is what a person does without any of this: scroll to the
most recent failure.

| Dataset | Top memory has the same label | One of the top five | Baseline: the newest failure |
| --- | --- | --- | --- |
| Gutenberg held-out (167 questions) | **87.4%** | 93.4% | 62.9% |
| Gutenberg August-2 (483) | **94.8%** | 96.7% | 61.9% |
| Supabase (727) | **99.7%** | 99.9% | 97.2% |

A free lexical index beats scrolling by 25 to 33 points on the two Gutenberg weeks. Embeddings were
therefore not bought: they would have to beat *this*, not beat nothing, and the cost per answer
stays at zero. That is the phase's own rule honoured - retrieval before generation, and only pay
for the model when the free thing has been measured and found wanting.

What makes the answers citable rather than plausible: every line names the run it came from, the
date, and which rule or which **person** decided it. A failure someone corrected outranks one only
Tewip decided, because what the team concluded beats what the tool concluded. When nothing
resembles the question it says so - "that is an answer, not a failure" - instead of returning the
nearest thing it has.

Found by running it on a stranger's project rather than a fixture: the index was built from a
220-character *display* string, and pytest puts a long absolute path first, so on humanize every
indexed character was the path and the words that mattered were never indexed at all. Searching a
history made entirely of one error found nothing. It now indexes the whole message and trims only
for reading.

### Phase 18: The Thread from Business to Release

The pieces exist and are not joined: `spec`, `plan`, `jira`, release readiness. Phase 18 is the
thread - requirement, specification, scenario, test, run, defect, release - so the question an
executive actually asks has an answer with evidence: *is this requirement covered, and is it passing
right now?* This is mostly joining what is built, and it is what makes Tewip an SDLC and STLC
product rather than a testing tool.

Phase metric: for a real backlog, the share of requirements Tewip can trace end to end, and the
share of its "covered" claims that survive a reviewer checking them.

Status (2026-09-26): **built** as `tewip trace`. Nothing new is stored: it joins what was already
there - the plans `tewip plan` wrote, the tests `tewip write` created, and the runs `tewip explain`
kept - and answers the one question the rest of Tewip could not: *is this requirement covered, and
is it passing right now?*

Four standings, and three of them are admissions:

- **passing** - a real run attempted the test and recorded no failure;
- **failing** - a real run recorded a failure, quoted with Tewip's own diagnosis and confidence;
- **never run** - a test is named, but no run kept here has attempted it, so its standing is
  unknown rather than assumed good;
- **not covered** - no test can be named for it, so nothing is checking it.

Proved end to end on a real project, both ways. A plan of 7 scenarios began as 7 *not covered* -
truthfully, because the planner marks coverage only when it can cite a real test. `tewip write`
turned two of them into verified tests; after a run, the thread read **2 passing** with the run
quoted. Breaking the code on purpose turned CT-005 into **FAILING - REAL_BUG at 0.70 (rules)**,
traced from the words someone asked for all the way to the diagnosis. Restoring the code turned it
back.

Two faults were found by running it on that project rather than on a fixture: plans are saved as
`{ plan, feature, urls, model }`, so reading the top level found no plans at all in a project that
had one; and a scenario nothing checks was printed with the last run beside it, which invited the
reader to think something had checked it. A run is now quoted only where it says something about
that scenario.

Not measured: the phase metric, which needs a real backlog and a reviewer willing to check the
"covered" claims. The mechanism is proved; the number needs people.

### Phase 19: Goal-Driven Operation

Tewip is verbs a person calls. Phase 19 is a goal - "keep the checkout flow green this sprint" -
with Tewip choosing its own next action. The refusal discipline is not relaxed for this phase; it is
the reason the phase is safe to attempt at all. An agent that acts without proof is the thing 29% of
teams rolled back.

Phase metric: over a sprint, actions taken without a person asking, each with the evidence that
justified it, and zero changes kept that were not proved. Autonomy is only worth counting when the
false-action rate is zero.

Status (2026-09-26): **built** as `tewip pursue "<a goal>"`, and the design is the argument.

"Agentic" usually means a model deciding what to do next. That is the part teams roll back: an
agent choosing freely cannot be predicted, and its reasons are a paragraph rather than a rule. The
answer here is the one that made diagnosis cheap and trustworthy, one level up - **the deciding is
a written policy over observed state, not a model.** The model still does the work where it is
good; it does not decide whether to act, where it is a liability.

The order is fixed, published, and testable:

1. a **real bug** - the goal is already broken, and it goes in front of a person;
2. every failure is the **environment** - re-run, and do not touch the tests, because nothing about
   the code has been shown;
3. **flakiness** - the code may be fine and the test is lying;
4. anything **still failing that Tewip cannot explain** - it will not move on while something it is
   watching is red;
5. a **coverage gap**, worst priority first, only once nothing is failing;
6. **attest**, and stop - "there is no next action worth taking".

Deciding is free and always allowed; anything that changes a file is refused unless the person asks,
and even then it runs through the gates that already prove a change. There is no unattended loop.

Two real faults came out of running it against a live project rather than fixtures:

- The policy printed "3 failing" in its own state line and then said "nothing the goal depends on is
  failing", because an **undecided** failure matched none of its branches and fell through to the
  coverage gap. Exactly the shape of contradiction this project exists to refuse. There is now a
  branch for it and an invariant test: for every category, a failing test is never walked past.
- Underneath it, `timing-intermittent` called a regression flaky. It was right by its own lights -
  the test really had flipped, because the code was broken and restored several times - but the
  runs recorded **no commit**, and without commits "the test comes and goes" and "somebody kept
  changing the code" are the same history. The rule now declines rather than guessing, and says so.
  Accuracy on all six real datasets is unchanged (96.4%, 86.1%, 93.4%, 97.9%, 89.0%, 99.7%), because
  real CI records the commit.

Not measured: the phase metric, which is a sprint of real use. What can be said is that the false
action rate is zero by construction - `pursue` has never changed a file - and that the policy is
deterministic, which a test asserts by deciding the same state five times.

### Phase 21: Carrying It Out

Phase 19 decided and stopped. Phase 21 lets `tewip pursue --act` do the thing it chose. This is the
first place Tewip acts because it decided to rather than because somebody typed a verb, so nearly
all of it is refusals.

Phase metric: over a sprint of real use, actions taken without being asked, each with the evidence
that justified it, and zero kept changes that were not proved.

Status (2026-09-26): **built**, as `--act` on `tewip pursue`.

Five rules hold it in place:

1. **It never does the work itself.** Every action it may take is an existing command that already
   proves what it changes - `write` keeps a test only when it passes and also fails when broken.
   Nothing new is trusted here; the measured gates stay in the path.
2. **Only an allowlist runs.** Two things are on it: write a missing test, and attest a green goal.
   Everything else is refused by name, so widening autonomy later is an edit somebody makes on
   purpose rather than a behaviour that emerges. A real bug is deliberately not actionable - Tewip
   will not work around one.
3. **One action, then stop.** There is no loop that runs until it decides to stop.
4. **Everything is written down**, to `.tewip/actions.jsonl`: what it did, what it refused, why, on
   which run, and what came of it. "The agent changed something" is never a mystery.
5. **It will not repeat itself.** The same action on the same target is refused until a new run
   gives it new evidence, which is what stops a scheduled job grinding at an impossible task.

Verified end to end on a real report rather than fixtures: a failing checkout total was called
REAL_BUG by the model at 0.99, and `--act` refused it in those words and logged the refusal; the
same goal, once green, had its attestation actually produced; and running it again over the same
report refused to repeat the work and said when it had last tried.

One real defect came out of building it, and it is worth recording because it is the exact failure
mode this phase is about. The first version re-entered Tewip with `process.argv[1]`, which is the
command line only when a person typed it. Under the test runner `argv[1]` is the test file, so
acting ran the test file, which acted, which ran it again: a fork bomb that froze the machine twice
before the cause was clear. What re-enters Tewip is now resolved from the build's own location, and
if it cannot be found nothing is carried out at all. A test asserts the entry point is the command
line and never a test file. **An agent allowed to start processes needs to know exactly which
process it is starting** - the blast radius of a wrong answer is not a bad report, it is the
machine.

Not measured: the phase metric, which needs a sprint of somebody's real use. What can be said today
is that no action outside the allowlist has ever run, and that every action and refusal is on disk
to be checked.

### Phase 22: Does This Test Prove Anything? (`tewip vouch`)

By 2026 most tests in a pull request were written by an agent, and nobody checks the one thing that
decides whether they are worth anything: **a test that cannot fail is a lie.** Coverage counts it.
CI goes green on it. A reviewer skims a plausible-looking test and approves. This is the verification
gap in its purest form, and it is the gap Tewip exists to stand in.

`tewip vouch <paths>` reads tests somebody else wrote - an agent, a contractor, last year's team -
and says, per test, whether it could ever fail. Not a style score: a verdict with the line that
justifies it.

What it looks for, in order of how badly it matters:

1. **No assertion at all.** The body exercises code and checks nothing.
2. **An expectation that was never finished** - `expect(value);` with no matcher. It reads as a
   check, runs clean, and asserts nothing. A real and common shape.
3. **A tautology** - `expect(true).toBe(true)`, or a value compared with itself.
4. **A body that swallows its own failure** - everything inside a `try` whose `catch` logs or passes.
   An assertion failure is an exception, so the test reports success no matter what happens.
5. **A test that only checks the mock it just configured**, which proves the mocking library works.
6. **A test that never runs** - skipped, disabled, or excluded by a `.only` somewhere else.

The discipline is the same one that makes the rest of Tewip worth installing: **where it cannot tell,
it says so rather than guessing.** A body whose checking happens inside a helper it cannot follow is
reported as undecided, not as vacuous. A wrong accusation about somebody's test costs more than a
missed one, because it is the reviewer's time and their trust.

Phase metric: precision first - of the tests it calls unable to fail, the share that really cannot,
read one by one on real public code; and recall against real commits in which a developer fixed a
test that was not testing anything. A false accusation rate near zero is the requirement, as with
every other gate here.

Status (2026-09-27): **built** as `tewip vouch <paths>`, and the precision half is measured on real
public code. No model, no cost: every verdict quotes the line it rests on.

Measured on **5,448 tests in 8 public projects across 5 languages** - express, axios, chalk (AVA),
psf/requests, pallets/click, gorilla/mux, spf13/cobra, google/gson:

| | count | verified |
| --- | --- | --- |
| Tests that **cannot fail at all** | 19 | **19 of 19 correct (100%)** |
| Tests that **compare no value** (only a crash fails them) | 65 | 6 read at random, all correct |
| Not judged, by refusal | 49 | - |

The 19 were read one by one against the files: one unconditional `@pytest.mark.skip` in psf/requests
and eighteen `@Ignore` methods in gson, including a whole `PerformanceTest` class disabled behind a
`testDummy` written "to prevent JUnit from complaining when we disable all tests".

**The result that matters is a wording change, not a count.** The first version called these tests
"cannot fail, so it passes whatever the code does" - and that is false. A test with no assertion
still fails when the code throws, and in axios a test that compiles a TypeScript fixture and runs it
asserts nothing *on purpose*: the crash is the check. On this corpus that claim would have been made
about 143 tests in seven projects, every one of them wrong. The verdict is now `crash-only`, worded
for what it is, reported apart from what really cannot fail, and kept out of the `--strict` gate.
Overclaiming about somebody else's tests is the precise failure this project exists not to commit.

Seven false-positive classes were found by pointing it at real code, each now covered by a test:

- **Test code inside a string.** Fixtures quote fake tests; Tewip's own suite produced 27 confident
  false accusations before offsets inside strings, template literals and comments were masked out.
- **AVA and tap put assertions on the test's context** (`t.is`, `t.same`). All 59 tests in chalk were
  condemned. This is the third time a narrow assertion vocabulary has produced wrong refusals in this
  project, after Cypress's `.should(` and `assert.equal` in Phase 8.
- **Mocha's `done` is the assertion.** `it('...', function(done){ app.on('foo', done) })` fails by
  timeout if the event never fires. express has dozens; they are checks, not gaps.
- **A Go benchmark is not a test that forgot to assert**, nor is an Example or a Fuzz target.
- **A `def test(...)` nested in another def is not a test**: in Click's suite it is a CLI command.
- **A conditional skip runs somewhere.** `@pytest.mark.skipif` on Windows-registry tests, and cobra's
  `t.Skip()` inside `if runtime.GOOS == "windows"`, both run elsewhere.
- **A `def` whose parameters span several lines.** The parameter list was read as the body and the
  real body discarded, so tests in psf/requests that assert plenty looked like they compared nothing.

Wired in where it pays off (2026-09-27), because a verb nobody runs checks nothing:

- **`tewip review`** ends with the tests in the diff that cannot fail, and stays silent when they are
  all sound. Verified on a real express commit, where the changed test file is sound and the section
  correctly did not appear.
- **The GitHub Action**, on a pull request, reads the test files the change touched and puts the
  finding in the comment - including on a **green** run, which is the case it exists for and the case
  the first version of the wiring dropped, because the comment returned early with "all tests passed".
- **The attestation** carries any such test as a **refusal**, so a release decision taken from the
  bundle cannot rest on a test that proves nothing. The line "a passing test is counted, not examined"
  is reworded when they really were examined, rather than left to contradict the claim beside it.

Where the diff cannot be read - a checkout with `fetch-depth: 1` has no base - nothing is reported
rather than a guess at which files changed.

Not measured: **recall.** Nothing here says what share of vacuous tests it finds, only that what it
reports is right. This was attempted the way the Phase 8 wait fixes were measured, and the attempt
failed, which is worth writing down so nobody repeats it:

- **Mining commit messages does not work for this.** 506 commits were searched across eight phrasings
  a developer might use ("test was not asserting anything", "test never fails", "forgot to assert").
  80 looked like candidates. Exactly **1** had a message that really said it - and reading that one
  showed the test already had `assert data["surfaces"] == {}` before the commit, so the developer was
  adding a second check and Tewip was right to say nothing. The label was wrong, not the tool.
- **"A developer added an assertion" is not a label**, because that describes most test commits.
- **Seeding vacuity is circular** if the seeding deletes what the detector looks for, which guarantees
  a meaningless 100%.

So the number is not published. Two routes would give a sound one, neither cheap enough to do beside
the precision run: an independently labelled corpus of assertion-free tests, from the test-smell
research datasets, where somebody else decided what counts; or mutants proved by execution - break
the code a test covers, run it, and see whether it notices - which is real mutation testing and needs
each project's suite installed and runnable. Until one of those is done, `vouch` is a tool with
measured precision and unknown recall, and the report says as much rather than implying it found
everything.

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
- ~~Do not add support for other test frameworks (Cypress, Selenium, Jest) — Playwright only~~ Changed 2026-09-19 at the owner's request: the agent must work across languages and frameworks. Any framework that emits JUnit XML (pytest, Jest, Vitest, JUnit/Maven/Gradle, Go, .NET, Cypress, Selenium) gets root-cause triage, PR comments, history, corrections and MCP. Playwright keeps the deep features: traces, page snapshots, selector drift and verified auto-fix. Deep support for another framework (reading its own artifacts, auto-fixing its selectors) is still a deliberate decision, and needs real data for that framework before any fix is trusted
- Do not add multi-tenancy, billing, or user accounts at any phase in this repo
- If I ask for something outside the current phase, remind me which phase it belongs to and ask whether I want to reorder deliberately

## Working Agreement

- At the end of every phase, print: what was built, the phase metric, and what the next phase needs from me
- If a phase metric target is missed, say so plainly. Do not soften it or move the goalposts
- Keep every file under 300 lines. Split when it grows past that
