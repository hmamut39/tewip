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

**New projects.** `data/real/jupyterlab` (Galata UI suite, 91 failures, 41 labels, **90.2%**) and `data/real/lxdui` (`canonical/lxd-ui` pull-request suite, 352 failures, 69 labels, **91.3%**) are the fourth and fifth public projects. On both, the deterministic rules were right on every case they decided (34/34 and 63/63); every miss is an AI answer on a cross-branch flake. Nextcloud harvests fine but only 1 case in the window had the evidence to label.

**Other projects.** `data/real/penpot` (21 runs; most had expired) yields only 5 labelled cases, because Penpot's tests wrap locators in helpers, so the v4 rule cannot read its fixes. Ghost could not be harvested at all from outside: it uploads blob reports only for failed runs and keeps them roughly a day (3 of 255 runs survived). A project has to run the agent **inside** its own CI to get reliable data.

**Known limits of these labels.** The labels are written by Claude from CI evidence, not by a human.
- For "passed on retry" cases, the label and the `timing-retry-pass` rule use the same fact, so agreement between them is partly built in.
- TEST_DATA has no labelled cases, and LOCATOR_DRIFT has almost none.
- "Outdated test after an intended UI change" occurs in real data but has no category in the taxonomy.

## Label format

Each line of the file is one JSON object:

```json
{"testId":"checkout.spec.ts > pays with card","runId":"run-20260914T081500000Z","label":"LOCATOR_DRIFT","dataset":"real","labeledBy":"your name","note":"button id changed from #pay to #pay-now"}
```

- `testId` and `runId` must match a record in `data/triage.jsonl`. Run `npm run diagnose` to see the ids.
- `label` must be one of `REAL_BUG`, `LOCATOR_DRIFT`, `TIMING`, `ENV`, `TEST_DATA`.
- If you leave out `runId`, the label applies to every collected failure of that test. Do this only when the cause can't differ between runs.
- Decide each label from the failure itself (the trace, the diff, the fix that was eventually made). Don't use the pipeline's answer, or the eval ends up measuring the pipeline against itself.
