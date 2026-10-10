---
name: explain-a-failure
description: Use when a test fails, a CI run is red, or someone asks why a test is failing or whether a failure is flaky. Reads the test report and gives a cause with evidence - a real bug, a changed selector, a timing problem, the environment, or bad test data - instead of guessing from the error message. Triggers on "why did this fail", "the build is red", "is this flaky", "CI is failing".
---

# Why did it fail?

The instinct on a red test is to read the error message and guess. The guess is usually "flaky", and it
is wrong often enough to hide real bugs - which is how a suite stops being believed.

Tewip decides from the report, the history of that test, and deterministic rules before any model is
asked. Each answer carries the evidence it rests on and says which layer decided.

## What to call

- **`explain_failure`** — one failing test, explained: the cause, the confidence, and the evidence.
- **`triage_board`** — the whole of the latest failed run, grouped by what should happen to each failure.
- **`recall`** — has this project seen this before? Returns what was decided last time and who decided
  it. Use it before forming your own opinion about a repeat failure.

If the project has not stored any run yet, point the person at `tewip explain <report>` on their CI
report, which is what gives these tools something to read.

## How to read the answer

The five causes mean different things and want different actions:

- **REAL_BUG** — the application is broken. Do not touch the test.
- **LOCATOR_DRIFT** — the test looks for something that was renamed. The test is wrong, the app may be fine.
- **TIMING** — the test is racing. Fix the wait, not the timeout.
- **ENV** — the machine, the network or a dependency. Re-run before changing anything.
- **TEST_DATA** — a precondition the test assumed is not there.

An **UNKNOWN** is Tewip saying it could not tell. Treat that as a question, not as permission to guess:
read the evidence it gathered and decide yourself, and say that you are the one deciding.

## What to tell the person

Give the cause, the confidence, and the one line of evidence behind it. If the verdict came from the
model rather than a rule, say so. If it is UNKNOWN, say that plainly rather than offering your own guess
dressed as a diagnosis.
