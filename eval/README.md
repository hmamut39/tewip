# eval/

Ground truth for measuring the diagnosis pipeline (rules first, then the LLM for anything the rules leave UNKNOWN).

| File | What it is | In git? |
|---|---|---|
| `ground-truth.synthetic.jsonl` | Labels for the 5 pipeline-debug specs in `tests/`. Used to check that the pipeline runs end to end. **It is not a product metric.** | yes |
| `ground-truth.jsonl` | Your hand labels for **real** CI failures. The Reality Check Gate needs 100 of them before Phase 4. | **no** (gitignored: labels describe real failures) |

```bash
npm run eval:synthetic   # pipeline check on the synthetic suite
npm run eval             # the real metric, once ground-truth.jsonl exists
# add -- --verbose to see the model's reasoning, -- --no-llm to measure the rules alone
```

**Rules-7 (2026-09-18): a click that cannot land.** Playwright sometimes finds the element, waits until it is "visible, enabled and stable", and still cannot click it because a snackbar, menu or overlay is on top: the error names the element that "intercepts pointer events". Across all nine labelled datasets that text appears in **32 failures and every one of them is labelled TIMING**, so a deterministic rule now answers them at 0.8 confidence, below the auto-fix line.

It moves work from the weaker half of the pipeline to the stronger one. On the Aug 20-26 week the rules now decide 421 cases instead of 406 and the score rises **86.0% -> 89.0%**; the fresh set rises 93.0% -> 93.4% and its rules layer is right on 171 of 174. Dev, held-out, Aug 27-31, Supabase, Penpot, JupyterLab and LXD UI are unchanged, and the drift auto-fix count (14, none wrong) is untouched.

**Rules-8 (2026-09-19): known flaky tests, and a merge gate.** Taken from how flaky-test products work: a test that has flaked once stays flagged. Across all nine labelled datasets, every failure of a test that had earlier failed and then passed on a retry is TIMING or ENV, never a real bug or a changed selector, on every project. The new rule calls such a failure TIMING when its error matches the earlier flake, and steps back when a request failed during the test. Dev 96.0% -> **96.4%**, held-out 85.5% -> **86.1%**, all other datasets unchanged.

The merge gate lets through failures that a rule (at 0.7 or more) or a person called TIMING or ENV. Checked against every labelled failure: it first let through 1,824, of which one was a real bug. A new test on a feature branch hit a 500 from new backend code, and `env-server-error` had called it ENV. That rule now steps back when a test has never passed, since there is then no baseline to say the backend was fine before. After the change: **1,823 let through, none of them a real bug, changed selector or test-data problem; 84.4% of flaky and environment failures unblocked**, and accuracy unchanged on all nine datasets. The zero is in-sample, found and fixed on this data.

**Code review (2026-09-19).** A high-effort review of everything since rules-4 found ten bugs, all fixed with tests: people's `/triage #n` replies were matched against the newest numbering rather than the one they saw, and the numbers were not shown in the comment at all; the map took the error of a test's first attempt instead of the diagnosed last one; truncating a huge comment could cut the map; maps posted with a maintainer's token and replies past the 100th comment were missed; an unnamed suite's history cache could restore a named suite's (this resets each repository's history once, on the next run); cached AI answers counted against the call budget; the editor tool missed reports in busy repositories. The subtle one: a real regression that happened to share an old flake's error could have been let through the merge gate as "known flaky". Such a failure, one that fails every retry on its commit while passing elsewhere, is still called TIMING (usually correctly), but at 0.6, below what the gate trusts. All nine datasets are unchanged; the gate lets through 1,822 failures, none of them real bugs.

## How much of a score is noise

Three runs of the **identical** pipeline over the held-out set scored **142, 143 and 144** of 166 (85.5%, 86.1%, 86.7%). The model samples its answers, so a score moves by about one case per 150 on its own. **A difference that small is not a result**, in either direction, and the eval now prints that reminder under every score.

Two ways to remove the noise were measured and both rejected: `temperature: 0` makes runs perfectly repeatable and **collapses accuracy from ~143 to 121 of 166** (greedy decoding reasons worse), and a fixed `seed` alone does not stabilise anything (140, 142, 144). The cache is what keeps day-to-day comparisons stable: an unchanged request returns its stored answer, so only what actually changed is re-asked.

## Real data from public CI (`eval/harvest/`)

```bash
npm run harvest -- gutenberg --from 2026-09-08 --to 2026-09-11   # every finished run in the window
node eval/harvest/evidence.ts gutenberg                          # labelling evidence per failure
```

- `harvest.ts` downloads each run's Playwright blob report from a public GitHub repo with the `gh` CLI, **including passing runs**, so each test's history is realistic. It writes records in the reporter's format to `data/real/<source>/`, which is gitignored. Corrupt shards in an artifact are skipped and noted in `runs-meta.jsonl`.
- `evidence.ts` collects facts the pipeline can't see at triage time. For each failure it answers:
  - Did a retry, or a re-run of the same commit, pass?
  - Does the test also fail on unrelated branches?
  - What changed before the test passed again on the branch: app code, the failing spec, or both?

  Labels are set from this evidence **before** the pipeline's answers are looked at.
- `label.ts` turns the evidence into labels using explicit rules. Anything the evidence can't settle is excluded, with the reason counted, rather than guessed.

**Dev set and held-out set.** `data/real/gutenberg` (Sep 8–11) was used to find and fix mistakes, so its score is optimistic. `data/real/gutenberg-holdout` (Sep 4–7) is labelled by the same script and was never used for tuning: **its score is the one to trust.**

```bash
npm run harvest -- gutenberg --from 2026-09-04 --to 2026-09-07 --dataset gutenberg-holdout
node eval/harvest/evidence.ts gutenberg gutenberg-holdout
node eval/harvest/label.ts gutenberg-holdout eval/ground-truth.holdout.jsonl 2026-09-04T01:00:00Z
npm run eval:holdout
```

**Fresh set.** `data/real/gutenberg-fresh` (Sep 1–3) was labelled after the prompt-llm-4 change, and nothing was tuned on it. On it the frozen pipeline scored **89.9%** (189 cases). Run it with `npm run eval:fresh`.

**Label rule v2 (2026-09-14).** After reviewing disagreements, one rule was added and applied to every dataset: a non-deterministic failure whose own trace shows a failed request to a third-party host is ENV. It came from failures of the external Openverse API, which v1 had labelled TIMING. The scores before and after the change are kept in the commit history.

**Second project: Supabase Studio.** `data/real/supabase` holds 623 runs of `supabase/supabase` `studio-e2e-test.yml` (Sep 10–16). They were harvested with `npm run harvest -- supabase`, which merges the per-shard `blob-report-next-N` artifacts into one run. Nothing was posted to that repository. With rules-4 it scores **99.7%** on 743 labels, but 731 of those are TIMING cases where the label and the retry rule share the same signal. The independent part is **REAL_BUG 6/6 and TEST_DATA 6/6**. `node scripts/shadow.ts supabase` renders the PR comments the agent would have posted; its report went to a private issue in the practice repo only.

**Label rules v3 (2026-09-17)**, applied to every dataset. For failures that passed on a retry:
- a data collision (duplicate key, unique constraint, "already exists") is TEST_DATA;
- a 5xx from the app's own backend in the trace is ENV;
- a test-level timeout or an assertion with a custom message is TIMING.

These came from reading Supabase's failure clusters before looking at any predictions. Rules-4 then added the matching `test-data-collision` and `env-server-error` rules ahead of the retry rule, so the rules-4 scores (dev 96.0%, held-out 86.1%, fresh 89.8%) are measured on data that was seen while designing them.

**Label rule v4 (2026-09-17): real "UI changed" examples.** When a fix removed the failing locator and added another locator for the same element (the two share a content word, e.g. `getByRole('button', { name: 'Edit' })` → `{ name: 'Edit link' }`), the case is labelled LOCATOR_DRIFT. A step removed without a replacement (an outdated test) and a replacement sharing only a role word are still excluded. This lifted the fresh set from 4 to **23 real drift cases**, the first sample large enough to measure the category the auto-fix loop acts on: **14/23 = 61%**.

**Rules-5 (2026-09-17): strict-mode drift.** A new rule reads Playwright's strict-mode errors: when an action's locator (e.g. `name: 'Edit'`) matches several elements and exactly one carries the name as a whole word, that element is the one the test means, and Playwright's error already prints a unique locator for it. It was designed while reading the fresh set's drift cases, so the fresh gains are optimistic: drift **14/23 → 16/23**, real bugs called drift **5 → 3**, overall **88.4% → 90.3%**, and **15** real drift cases (14 fresh, 1 held-out) become auto-fix eligible with **0 wrong**. All 17 of its suggestions equal the locator the developers wrote in their fix. Dev, held-out, Supabase and Penpot scores are unchanged.

**Unseen window `data/real/gutenberg-aug` (Aug 27–31),** harvested and labelled after rules-5 was frozen (`npm run eval:aug`): **97.6%** on 335 labels (TIMING 243/248, ENV 81/83, REAL_BUG 3/4). It contains no drift cases, so drift recall could not be confirmed there. What it does confirm is precision: the strict rule met 12 strict-mode errors (duplicate media items, duplicate taxonomy checkboxes) and called none of them drift. Reading them exposed one flaw, now fixed: Playwright shortens long names in its suggestions, which made identical items look like different ones in the rule's note.

**Prompt llm-5 (2026-09-17): substring matches.** Playwright matches accessible names by substring, so a locator can match several elements without the intended one being there. The model is now told that this is only LOCATOR_DRIFT when one match carries the name as a whole word. Re-measured on every dataset: dev 95.6% -> **96.0%**, fresh 90.3% -> **91.2%** with real bugs called drift **3 -> 1 of 29**, held-out 86.1% unchanged (real bugs called drift 3 -> 2), unseen Aug window 97.6% -> **97.9%**, Penpot 5/5, drift lab 10/13 -> **11/13** with 0 false fixes.

Supabase moved 99.7% -> 99.6%: one REAL_BUG was answered TIMING. That is **model sampling noise, not the change**: asked again five times with the new prompt and five times with the old one, the same case came back REAL_BUG all ten times. Each eval stores one answer per case, so single-case differences of this size are within the noise of the method.

**Label rule v5 (2026-09-17): a case-only rename cannot be the cause.** Three fresh-set cases were labelled LOCATOR_DRIFT because the fix replaced `getByRole('button', { name: 'Browse All' })` with `{ name: 'Browse all' }`. Playwright matches accessible names case-insensitively unless the locator asks for `exact`, so that rename cannot be what fixed the failure; something else in the same pull request did (it also rewrote the test's hover logic and changed 127 app files). Those cases are now excluded as unlabellable, in every dataset.

This raises fresh-set drift from **16/23 = 70%** to **16/20 = 80%**, so the 80% target is met on corrected labels but not on the original ones. **Both numbers belong together:** the flaw was found while reading the pipeline's misses, so the correction was made after seeing predictions. Its justification is documented Playwright behaviour rather than the outcome, but the risk of label bias is real and is why the pre-correction number is kept here.

**Third unseen window `data/real/gutenberg-aug2` (Aug 20–26, 934 runs, `npm run eval:aug2`),** harvested and labelled after rules-5 and llm-5 were frozen: **86.3%** on 473 labels (TIMING 271/331, ENV, REAL_BUG 17/21) and **LOCATOR_DRIFT 3/3**. Those three are drift the rule had never seen, and of a different kind than the strict-mode rule handles: the test asked for an `exact` name and the button's label changed, which the similarity rule caught at 0.80, below the auto-fix threshold. The agent would have made **0 automatic changes** in that whole week.

**Rules-6 (2026-09-17): tests that come and go.** The biggest error class left was flaky tests read as real bugs. History now counts how often a test switched between passing and failing **on its own branch** (counting across branches was tried first and was wrong: the same test legitimately passes on one line of work and fails on another, which cost the fresh set 9 points before the mistake was found). A test that keeps flipping is TIMING at 0.7, well below the auto-fix line; it declines when a request failed during the test, because a dependency that fails now and then is ENV. The rules also read **every attempt's** trace for failed requests now, not only the last one.

Result across nine datasets: JupyterLab 87.8% -> **90.2%**, and dev 96.0%, held-out 86.1%, fresh 92.5%, Aug 27-31 97.9%, Aug 20-26 86.3%, Supabase 99.6%, Penpot 5/5, LXD UI 91.3% all unchanged. Lab unchanged (11/13, 0 false fixes).

One finding worth keeping: an earlier wording of that rule's decline note ("a flaky dependency, **not necessarily a race**") moved two held-out cases from ENV to TIMING, costing 1.2 points, while the rule itself never fired on them. The notes rules write are read by the model as checked facts, so their wording is part of the system and is measured like code.

**Tried and rejected (2026-09-17): "fails on other commits, passes on others" as a flakiness signal.** The largest remaining error class is flaky failures read as real bugs (59 of them on the Aug 20-26 week). Extending the intermittency rule to fire when a test fails on several other commits while passing on others looked like the fix, and it is wrong in principle: a renamed element produces exactly that pattern, because commits before the change pass and commits after it fail. Measured, it cost the fresh set 1.9 points (92.5% -> 90.6%) and the held-out set 0.6, so it was reverted. Only flipping back and forth **within one branch** separates a flaky test from a broken one, and that is what the rule uses.

**Tried and rejected (2026-09-17): a second opinion from the model.** Asking the same model again with more reasoning effort, on every failure the AI layer decided, then comparing the two answers. On the fresh set disagreement did flag mistakes (of 5 disagreements, the first answer was wrong in 4), but on the held-out set it did the opposite: of 7 disagreements the first answer was right in 4 and the second in only 1. Taking the second opinion would have gained 1 case on the fresh set and lost 3 on the held-out set. As a "needs a human" flag it is also weak: it raises the hand on 12 of 76 cases and catches 7 of the 27 mistakes. It doubles the cost of the AI layer for no measured gain, so it is not in the agent. The measurement is worth repeating when the model changes.

**Harvest windows are short-lived.** Trying to grow the JupyterLab and LXD UI datasets over an older three-week window returned **zero** failures: both projects delete their CI reports within days, as Ghost does. A real dataset on those projects can only be built forward, which is why the weekly workflow now keeps each week's harvest in the Actions cache, adds to it, and re-scores itself.

**New projects.** `data/real/jupyterlab` (Galata UI suite, 91 failures, 41 labels, **90.2%**) and `data/real/lxdui` (`canonical/lxd-ui` pull-request suite, 352 failures, 69 labels, **91.3%**) are the fourth and fifth public projects. On both, the deterministic rules were right on every case they decided (34/34 and 63/63); every miss is an AI answer on a cross-branch flake. Nextcloud harvests fine but only 1 case in the window had the evidence to label.

**Other projects.** `data/real/penpot` (21 runs; most had expired) yields only 5 labelled cases, because Penpot's tests wrap locators in helpers, so the v4 rule cannot read its fixes. Ghost could not be harvested at all from outside: it uploads blob reports only for failed runs and keeps them roughly a day (3 of 255 runs survived). A project has to run the agent **inside** its own CI to get reliable data.

**Known limits of these labels.** The labels are written by Claude from CI evidence, not by a human.
- For "passed on retry" cases, the label and the `timing-retry-pass` rule use the same fact, so agreement between them is partly built in.
- TEST_DATA has no labelled cases, and LOCATOR_DRIFT has almost none.
- "Outdated test after an intended UI change" occurs in real data but has no category in the taxonomy.

## vouch's recall, judged by execution (Phase 138)

`tewip vouch` reads a test and says whether it could ever fail. Until now its **precision** was
measured and its **recall** was not: the report admitted it did not know how many hollow tests it
walks past. `eval/vouch-recall.ts` measures it without asking a developer or a commit message.

The method, and why it is not circular:

1. Take a real source file and the test file that covers it.
2. Make hollow tests **by a rule that knows nothing of vouch's vocabulary**: drop the last
   statement of a test. Sometimes that removes the only check; sometimes it removes something else.
3. Decide **by execution**. Mutate the source and record which tests fail, with the test file whole
   and again with the statement dropped. A test that caught mutant M before and catches nothing now
   has provably lost its check. That is the label.
4. Only then ask `vouch`, by reading, and compare.

Run it with `node eval/vouch-recall.ts <project> <source> <test> [--mutants 24]`.

**The figure, on this project's own 48 (source, test) pairs.** 28 pairs produce labelled cases. 22
of those settle - see below - and across them:

| | |
|---|---|
| Tests that provably lost their check | 64 |
| Named by vouch (cannot fail, or compares no value) | **48 (75.0%)** |
| Missed - vouch called them sound | 12 |
| Named as unable to fail *outright* | 0 |
| Sound tests wrongly accused | **0 of 157** |

Precision is the strong half, and it is the half that matters most: vouch did not once accuse a
test that still catches something.

**Why a rate is sometimes withheld.** The label rests on "caught nothing after the deletion", which
is evidence of hollowness only to the degree that the mutants are many. The first run of this
printed "named 2 of 4 (50.0%)" for `engine/audit/audit.ts` at 8 mutants; at 14 mutants of the same
file the denominator fell to **zero** - every test it had labelled had caught something after all,
and the two "misses" still held a real assertion. The 50% measured the mutant budget, not vouch. So
the harness now judges at two budgets (n and n/2, which share no mutants, because `mutantsFor`
spreads its picks rather than taking the first n) and prints a rate only when both label the same
tests. Six of the 28 pairs do not settle and are excluded from the table; they were the favourable
ones, so 75.0% is a floor, not a best case.

**What the measurement found.** Two real defects in `vouch`, both in the direction that matters -
a hollow test reported as sound - and neither findable by reading it:

- **A one-line helper was credited with assertions it does not contain.** `helpersThatCheck`
  scanned forward for the next `{` after a declaration. A concise arrow has none, so the scan
  landed in the next `describe`/`it` block and read *its* assertions. `const file = (...lines) =>
  lines.join(NL)` became a helper that asserts, and a stripped test calling it was told "it checks
  through `file()`, which asserts". Recall 58.7% to 70.3%.
- **A stub named `verify` was read as an assertion.** `verify` was matched as a bare word, so a
  fixture *defining* `verify: async () => ({ passed, detail })` counted as checking - and then the
  fixture builder itself counted as an asserting helper. Five of this project's own autofix
  fixtures have that line. Recall 70.3% to 75.0%.

**What this figure is not.** It is measured on this project's own test suite, not on strangers'
code, which is weaker evidence than the triage numbers above and is the next thing to fix. The
tests here are mostly written with several assertions each, so dropping the last statement often
leaves a real check behind - which is why 12 of the 64 "misses" need reading before they are
believed, and why several that were read turned out to be the label's fault rather than vouch's.

## secure's recall, measured by planting what the providers document (Phase 147)

`tewip secure` had a precision number - zero findings across 18,617 files of real code - and no
recall number. On its own that is the weaker half of a pair: a check that finds nothing scores
perfect precision.

`eval/secure-recall.ts` plants one credential per shape in a throwaway git repository and asks what
comes back. The shapes are written from **what each provider documents about its own tokens** - the
prefix and length AWS, GitHub, Stripe, Shopify and the rest publish - and not from Tewip's
patterns, which is what stops the measurement being circular. Nothing in that file is a credential:
every value is assembled at run time from a seeded generator, so the file holds formats and no
secrets.

Run it with `node eval/secure-recall.ts`.

| | |
|---|---|
| Credential shapes planted | 20 |
| Matched by some pattern | **20 (100%)** |
| Kept by triage as needing action | **20 (100%)** |
| Decoys planted beside them | 5 |
| Decoys wrongly called a credential | **0** |

The decoys are a UUID, a commit hash, an encoded image, an ordinary sentence and an obvious
placeholder. A recall number with no precision beside it can be bought by reporting everything.

**It started at 70%.** Four shapes had no pattern at all - Shopify, Mailgun, Azure storage and
Datadog - and those were added, because each is a format its provider publishes. A pattern added
to satisfy its own measurement would make the measurement worthless; these were added because the
provider documents them and Tewip had nothing. Datadog's is 32 hexadecimal characters and nothing
else, which is also an md5 and half the entries in a lockfile, so it requires the key name beside
it and is the one shape here that is context-dependent.

**Three of the first run's misses were the harness being wrong, and each one was Tewip being
right.** They are worth listing, because they are what hand-checking a miss is for:

- Every finding came back `not-reachable`. The planted files were in a directory git did not
  track, and a credential that was never committed never left the machine. Tewip said so.
- The JWT missed because the generator wrote a random payload. A real JWT's second segment always
  begins `eyJ`, because it is base64url of an object and `{"` encodes to exactly that.
- The basic-auth URL missed because the generator pointed it at `example.com`, a domain reserved
  by RFC 2606 so that it cannot be anybody's system. Tewip declines to raise those and says why.

**What it does not measure:** a credential in a shape nobody publishes - an internal token, a
password in a config file with no recognisable form. No pattern-based scanner finds those, and
this does not pretend to cover them.

## schema's recall, measured against what the databases document (Phase 148)

The corpus pins what `schema` reports on real projects, which holds it steady but cannot say what
it walks past: a migration nobody wrote is a migration nobody measures.

`eval/schema-recall.ts` plants one migration per case. The ground truth is the databases' own
documentation - PostgreSQL and MySQL publish which statements take which lock and which rewrite or
discard data - and each case is labelled with what the manual says rather than with what Tewip's
rules say. Dialects: raw SQL, Django, Rails, Alembic.

Run it with `node eval/schema-recall.ts`.

| | |
|---|---|
| Migrations planted that the manual calls harmful | 15 |
| Named with a harm the manual names | **15 (100%)** |
| Safe migrations planted beside them | 4 |
| Given the harm they avoid | **0** |

The four safe ones matter more than the count suggests: a nullable column, a new table, an index
built `CONCURRENTLY`, and a constraint added `NOT VALID`. The last two are the documented way to do
the dangerous thing safely, and a check that cannot tell them from the dangerous form teaches
people to switch it off.

**It started at 60%, and most of that was the measurement being wrong.** Four `DROP COLUMN` cases
scored as misses because Tewip called them `breaks-old-code` where the label said `destroys-data` -
and dropping a column does both. A statement usually does more than one thing, so each case now
carries every harm its manual describes and any of them counts.

**One real gap, and it was the constraint.** `ALTER TABLE ... ADD CONSTRAINT` without `NOT VALID`
had no raw-SQL rule at all; only the Laravel foreign-key shape did. On the corpus that added one
true finding and removed one false one - immich's initial migration adds a CHECK to a table the
same file creates, which locks nothing because the table is new and empty, and the existing
new-table rule now suppresses it where it used to be called `breaks-old-code`.

**What this cannot measure:** a migration that looks dangerous and is safe in context, because
context is what a file does not carry. The corpus covers that side, holding the false positive
count at zero across 14 real projects.

## access and agent, measured against their published ground truth (Phase 149)

Two more, finishing the set. Each one is planted from a source outside Tewip: for `access` the
W3C's own numbered failure techniques, for `agent` the shape each framework's quickstart shows.

`node eval/access-recall.ts` · `node eval/agent-recall.ts`

| | noticed | wrongly accused |
|---|---|---|
| `access` — 11 WCAG documented failures | **11 (100%)** | **0** of 11 documented fixes |
| `agent` — 10 framework tool declarations | **10 (100%)** | **0** of 4 decoys |

For `access`, every failure is planted **twice**: once as the markup the W3C describes as failing,
once as the markup the same page gives as the sufficient technique. A check that cannot tell the
documented fix from the documented failure teaches people to switch it off, and that half found a
real bug.

**The rule reported the fix it asked for.** `aria-hidden-focusable` tells you to *"remove it from
the tab order with `tabindex="-1"`"* - and doing exactly that did not clear the finding, because a
`<button>` was flagged for being interactive whatever its tabindex said. It had been that way since
the rule was written, and no real repository caught it: real code does not usually contain the
textbook fix.

For `agent`, the decoys are the four shapes that were found being reported as real tools on real
repositories while that command was being built - an example inside a docstring, a commented-out
registration, a usage block in JSDoc, and a fixture in a test folder. They are measured rather than
assumed, because each one was a live defect once.

**Where the set now stands:**

| check | precision | recall |
|---|---|---|
| `vouch` | 0 of 157 sound tests accused | 75.0%, measured by execution |
| `secure` | 0 findings on 18,617 real files | 100% of 20 published credential shapes |
| `schema` | 0 false positives on 14 projects | 100% of 15 documented harms |
| `access` | 0 barriers on Google's Compose samples | 100% of 11 WCAG failures |
| `agent` | 0 findings on 1,691 real files | 100% of 10 framework shapes |

Every recall number above was measured against something published by somebody else - the W3C, the
database manuals, the providers' token formats, the frameworks' quickstarts - and not against
Tewip's own rules. That is the only reason any of them means anything.

## Label format

Each line of the file is one JSON object:

```json
{"testId":"checkout.spec.ts > pays with card","runId":"run-20260914T081500000Z","label":"LOCATOR_DRIFT","dataset":"real","labeledBy":"your name","note":"button id changed from #pay to #pay-now"}
```

- `testId` and `runId` must match a record in `data/triage.jsonl`. Run `npm run diagnose` to see the ids.
- `label` must be one of `REAL_BUG`, `LOCATOR_DRIFT`, `TIMING`, `ENV`, `TEST_DATA`.
- If you leave out `runId`, the label applies to every collected failure of that test. Do this only when the cause can't differ between runs.
- Decide each label from the failure itself (the trace, the diff, the fix that was eventually made). Don't use the pipeline's answer, or the eval ends up measuring the pipeline against itself.

## the prompt-injection half of agent, which nothing had measured (Phase 152)

`agent` reports three things: the tools a model may call, the guards in front of them, and text
from outside glued into a prompt. Only the tools had a number, and the evidence pack printed that
number - "10 of 10 framework shapes read" - underneath every claim the command makes, the injection
flows included. A confidence figure standing in for a claim it was not measured on is worse than no
figure, because it gets believed.

`node eval/injection-recall.ts`

| | found | wrongly accused |
|---|---|---|
| 6 documented flows, one per framework shape | **6 (100%)** | — |
| 5 decoys, every one real code this check reported | — | **0** of 5 |

The decoys are the unusual part: none of them is invented. `tewip agent` found three
prompt-injection flows across n8n's 11,054 files and **all three were false** - a display
formatter building the label `[tool-result: x]`, a chat record doing
`message.content = message.content + content`, reported twice, and a log line. They are kept here
so that any fix has to keep finding the six real shapes to count for anything.

Two separate causes, each needing its own rule. `content:`, `input:` and `template:` are ordinary
object keys and are not evidence of a prompt, so they now count only when the same **statement**
also contains something that can only be a model. And a value appended to the field it was read
from is not glued into a prompt at all.

**The measurement was wrong before the code was.** The first version of the formatter decoy was
that function alone, it passed, and the real file went on being reported - because a file about
displaying LLM steps has `messages:` and `prompt` all through it, so a test that looks *nearby*
for a model always finds one. The decoy now carries the surrounding code, and the rule looks at
the statement rather than a window. A decoy that cannot reproduce the context cannot measure the
fix; this one reported success for a defect that was still live.

## every number here is re-derived in CI (Phase 152)

`engine/test/confidence-is-current.test.ts` runs five of these harnesses and holds both the counts
and the sentence in `engine/evidence/confidence.ts` to what they return. Before it existed nothing
re-derived any of them: a rule change would have left the evidence pack publishing "20 of 20" from
a string literal while the harness returned eighteen - a stated measurement that had quietly
stopped holding, in a signed document, read by somebody whose reason for reading it is that they
cannot run the checks themselves.

`vouch-recall` is excluded and the test asserts that it is the *only* exclusion, so a harness
cannot be added without either being re-derived or being named. It runs a real suite and mutates
real source, which takes minutes rather than the two seconds the others take together.

## the guards half of agent, which was finding 5 of 14 (Phase 153)

The third and last leg of `agent`. The tools had a number, the injection flows got one in Phase
152, and the guards had none - and were not even listed as unmeasured, while the pack printed this
about them:

> **Nothing anywhere in this project asks a person anything, declares a step ceiling, or draws its
> tools from a named list.** Where a tool can delete or pay, that is not a maybe.

Categorical, and an *absence* claim - the hardest kind to earn, because a shape the reader cannot
parse produces exactly the same silence as a shape that is not there.

`node eval/guard-recall.ts`

| | found | wrongly counted |
|---|---|---|
| 14 documented gates, Python and JavaScript form of each | **14 (100%)**, from 5 | — |
| 4 decoys that look like gates and stop nothing | — | **0** of 4 |

Every case is the shape its vendor's own human-in-the-loop page uses, named beside it: LangGraph,
CrewAI, the OpenAI Agents SDK, LangChain and the Vercel AI SDK. Nine of the fourteen were invisible.
Three causes:

**A stray word boundary, which cost seven of the nine.** `interrupt(?:_before|_after)?\s*[(=]`
inherited a trailing `\b` from its group, and a word boundary after `[(=]` demands that the next
character be a *word* character. So `interrupt(state)` matched, and `interrupt({"question": ...})`
and `interrupt_before=["tools"]` did not - the two forms LangGraph's own page is written in.

**String blanking hid configuration keys.** `graph.invoke(state, config={"recursion_limit": 25})`
arrived as `{"               ": 25}`, so a declared ceiling read as no ceiling. Blanking is right -
one decoy is `print("pass --dry-run to see what would happen")`, help text for a flag the code does
not implement - so the fix keys on shape: `"word":` is a key with a value under it.

**The JavaScript form of every framework whose Python form was already covered:** `interruptBefore`,
`needsApproval`, CrewAI's `human_input`, `HumanApprovalCallbackHandler`, and `stopWhen` /
`stepCountIs`, which is how the Vercel AI SDK declares a ceiling since it dropped `maxSteps`.

**The first fix was wrong, and real code showed it.** The quoted-key words were derived from the
pattern's own source so they could not drift - and it extracted *fragments*: `tool_allow_?list`
yields `list`, so every `'list':` in any object counted as a tool allow-list. nocodb's icon map and
two Saleor migrations came back as gating an agent's tools. A derivation that cannot tell a word
from a piece of one is not a safeguard against drift, it is a second thing to get wrong. The lists
are explicit now, and a test holds each key to its own pattern.

**Two more found on real repositories.** A JSON schema *declaring* `max_iterations` read as a
project *setting* it, which predates all of this. And `agent` was reading vendored minified
bundles: nocodb was credited with a human-approval gate because Swagger UI's minified code contains
the word `interrupt` somewhere in a megabyte of it.

**What it was getting wrong, concretely.** n8n's AI workflow builder calls
`interrupt({ type: 'plan', plan })` to have a plan approved, and its credential tool computes
`needsApproval` before deleting a credential. Before this, Tewip told a reader that n8n asks a
person nothing. nocodb went from four guard findings to none, every one of the four false; n8n from
one kind to all four, all nine of its `asks-a-person` findings genuine.
