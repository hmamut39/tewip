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
- `label-gutenberg.ts` turns the evidence into labels using explicit rules. Anything the evidence can't settle is excluded, with the reason counted, rather than guessed.

**Dev set and held-out set.** `data/real/gutenberg` (Sep 8–11) was used to find and fix mistakes, so its score is optimistic. `data/real/gutenberg-holdout` (Sep 4–7) is labelled by the same script and was never used for tuning: **its score is the one to trust.**

```bash
npm run harvest -- gutenberg --from 2026-09-04 --to 2026-09-07 --dataset gutenberg-holdout
node eval/harvest/evidence.ts gutenberg gutenberg-holdout
node eval/harvest/label-gutenberg.ts gutenberg-holdout eval/ground-truth.holdout.jsonl 2026-09-04T01:00:00Z
npm run eval:holdout
```

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
