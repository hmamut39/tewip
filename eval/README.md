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

## Label format

Each line of the file is one JSON object:

```json
{"testId":"checkout.spec.ts > pays with card","runId":"run-20260914T081500000Z","label":"LOCATOR_DRIFT","dataset":"real","labeledBy":"your name","note":"button id changed from #pay to #pay-now"}
```

- `testId` and `runId` must match a record in `data/triage.jsonl`. Run `npm run diagnose` to see the ids.
- `label` must be one of `REAL_BUG`, `LOCATOR_DRIFT`, `TIMING`, `ENV`, `TEST_DATA`.
- If you leave out `runId`, the label applies to every collected failure of that test. Do this only when the cause can't differ between runs.
- Decide each label from the failure itself (the trace, the diff, the fix that was eventually made). Don't use the pipeline's answer, or the eval ends up measuring the pipeline against itself.
