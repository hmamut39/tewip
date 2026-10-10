---
name: verify-before-done
description: Use before telling someone a code change is finished, ready, or done - especially after writing or changing tests. Checks whether the tests in the change can actually fail, whether they would catch a bug, and whether anything is broken, and returns one verdict. Triggers on "is this done", "ready to merge", "I've finished", "the tests pass", or before opening a pull request.
---

# Before saying the work is done

A passing test run is not the same as finished work. A test with no assertion passes. A test whose
expectation was never completed passes. A test that covers a line without checking it passes. Each of
those also counts towards coverage, so the usual signals all look green.

Use the `tewip` MCP tools to find out, rather than asserting it.

## What to call

1. **`is_the_work_done`** — one verdict over the change, from the layers that each have a measured
   accuracy: is anything failing, is the changed code tested by something that really reaches it, can
   the tests in the change fail at all, and is what was asked for covered. Pass the project path and a
   git range such as `main...HEAD`.

2. **`vouch_tests`** — when the change adds or edits tests and you want the detail: which of them could
   never fail, with the line quoted.

3. **`prove_tests_catch_bugs`** — the strongest check, and the slow one. It breaks a source file in small
   deliberate ways and runs the tests that cover it, reporting every change none of them noticed. Use it
   when the change matters and minutes are acceptable; say that it takes minutes before starting.

## How to read the answer

- **not ready** names what is wrong. Fix that, do not argue with it.
- **cannot say** is a real answer and is never an approval. It means a question that cannot be skipped -
  is anything failing, does anything test this code - could not be answered here.
- **ready** is bounded: it means the checks that ran passed. The report lists what it did not check, and
  that list is part of the answer, not a footnote.

## What to tell the person

Report the verdict and the reasons, including the parts that were not checked. If the verdict is not
ready, say so plainly before describing what you built. Never present "the tests pass" as evidence that
the work is done when these tools have not been run - that is the exact gap they exist to close.
