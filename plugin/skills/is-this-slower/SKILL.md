---
name: is-this-slower
description: Use whenever someone asks whether a change made something slower, whether a load test or Lighthouse result is a regression, or what a k6 or Lighthouse run means - and whenever a k6 summary or Lighthouse JSON appears. Separates whether the team's own thresholds held from whether the run is slower than the recorded baseline, and refuses to call a regression without enough baseline runs to tell one from noise. Triggers on "performance", "slower", "regression", "latency", "p95", "load test", "k6", "lighthouse", "core web vitals", "LCP", "benchmark", "is this fast enough".
---

# Is this change slower, and does it matter?

The temptation with performance numbers is to subtract and report a percentage. Do not. **Four real
k6 runs of code that did not change gave p95 of 60.8, 60.9, 61.4 and 62.8ms** - a 3% spread from
nothing at all. Any percentage quoted without knowing the run-to-run spread is as likely to be the
machine as the change, and saying it out loud is how a team learns to ignore performance reports.

## What to call

**`is_this_slower`** with the project path and the path to either a `k6 run --summary-export` JSON or
a Lighthouse `--output=json` report. It detects which it was given. Optionally `label`, when the
project measures more than one thing, so two suites are not each other's baseline.

The two measure different halves: k6 is what the server does under load, Lighthouse is what one page
load costs in a browser. A Lighthouse run is a **single** page load, which is the noisiest measurement
either tool offers - say so if you quote one.

It reads only. It never adds a run to the baseline - that stays a deliberate act on the command
line, because a regression recorded by accident becomes next week's normal.

## How to read the answer

Two answers, kept apart because they fail apart:

1. **Did the thresholds hold?** These are the limits the team wrote in their own k6 script. A breach
   is a fact, not a judgement - report it plainly.
2. **Is it slower than before?** This comes only from three or more recorded baseline runs. With
   fewer, the answer is **cannot say**, and that is the correct answer, not a gap to fill in.

## What you must not do

- **Do not convert a "cannot say" into a percentage.** If it says there are not enough baselines, the
  honest reply is "nobody can tell yet from this; record baselines on main first". Subtracting the
  two numbers yourself and reporting the difference defeats the whole check.
- **Do not predict a duration, a capacity, or what users will feel.** The run says nothing about the
  production hardware, the real data volume or the real traffic. No number you invent for those is
  better than silence.
- **Do not report "no threshold was breached" from a machine-readable summary.** That export records
  no threshold results at all; Tewip will say so. Pass that on as "your export does not contain them",
  and suggest re-running with plain `--summary-export`.
- **Do not restate a Lighthouse band as your own opinion.** "Poor" and "good" in the report are
  Lighthouse's scoring, not Tewip's and not yours. Attribute them.
- **Do not treat a thin run as evidence.** If the report says the request count is thin, a p95 from it
  is a handful of data points. Say so.

## What to tell the person

Lead with a breached threshold if there is one, then with anything called slower, quoting the
baseline range beside it so the claim is checkable. If the verdict is "cannot say", say that first
and say why - too few baselines, or the value sits inside what the baselines already did on their own.

Then the limits: which endpoints the script exercised, and that nothing here describes production.

If they want the regression investigated, that is a code question: look at what changed in the paths
the slow endpoint touches, rather than guessing from the number.
