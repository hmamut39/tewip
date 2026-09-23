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

> Direction changed 2026-09-19 at the owner's request: Tewip grows from failure triage into a full software-quality agent covering the whole testing and security lifecycle. It is built on top of general models instead of competing with general coding agents, and every output is verified. Application feature code stays with general coding agents, so Tewip keeps its promise never to edit application code.

### Phase 6: Test Plans (`tewip plan`) (BUILT — metric not yet measurable: no real PRs with later-found bugs yet)
From a feature description, a pull request's diff, and the running app's pages, write a test plan: scope, risks, scenarios with priorities, which test types apply (functional, accessibility, security, performance) and which to automate. Grounded in facts Tewip reads, never invented: the changed files, the tests that already exist, the pages as they are.

Phase metric: on real pull requests with later-found bugs, the share of those bugs whose scenario the plan named before the bug was found. Until that data exists, plans are shown as drafts.

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

### Beyond Phase 5: Continuous Improvement
The agent keeps getting stronger after the last phase, but only in measured steps: every human correction becomes a labelled example (built 2026-09-17: people reply `/triage CATEGORY #n reason` under the agent's own comment, and it uses their answer for that failure from then on), misclassifications drive new rules or prompt changes, accuracy and autonomy rate are re-measured on real data after every change. A change that lowers a measured number is not kept as it is: either its cause is fixed and everything is re-measured, or it is reverted. (Rule reworded on 2026-09-17 at the owner's request, so a regression leads to a root-cause fix rather than stopping.)

## Beyond diagnosis: what makes Tewip the tool a department opens every day

Phases 1 to 9 make Tewip the best answer to "why did this fail, and what do I do about it". Phases
10 to 14 are what turn that into daily use across a whole IT department: the work items people live
in, the designs they build from, the code they fix, and the places they already are. Every one of
them keeps the rule that makes Tewip worth trusting - **it says only what it can show** - and each
names what it deliberately will not do, because a tool that will not lie to you is the product.

### Phase 10: The Work Item Loop (`tewip jira`) (BUILT — reading measured on 150 real tickets; bugs-back and Xray/Zephyr not yet)

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
