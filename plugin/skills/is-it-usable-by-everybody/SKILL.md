---
name: is-it-usable-by-everybody
description: Use whenever a change touches an interface - HTML, JSX, TSX, Vue, Svelte or Astro - or when someone asks whether something is accessible, usable with a screen reader or a keyboard, WCAG-compliant, or ready under the European Accessibility Act. Names the barriers that reading the markup proves, keeps apart the ones only a person can settle, and lists every criterion it could not check. Triggers on "accessibility", "a11y", "WCAG", "screen reader", "keyboard navigation", "alt text", "aria", "Section 508", "EAA".
---

# Can everybody use this?

Accessibility is the one quality question that is also a legal one. The European Accessibility Act has
been enforceable since June 2025, and Section 508 and the ADA point at the same standard, WCAG 2.2 AA.

It is also the question where tools have the worst reputation, for one reason: axe, Lighthouse and pa11y
return several hundred undifferentiated violations, a large share of which are not barriers, and the team
switches the check off. Do not reproduce that behaviour by relaying a long list.

## What to call

**`accessibility_barriers`** with the project path, and optionally a single file or directory.

It reads markup only. No browser, no network, no model, so it costs nothing and takes about a second.

**If the project already runs axe** — in a Playwright, Cypress or jest-axe suite — pass its JSON as
`axeReport`. Look for one before saying contrast cannot be checked. It changes three things: contrast
moves out of the unchecked list, axe's findings are triaged rather than relayed, and source findings for
pages the run actually opened are set aside instead of being counted twice.

Be careful how you report what comes back from a run. On nine real pages, **51 of axe's 174 findings
mapped to no WCAG criterion at all** — `region` alone was 40 of them. Tewip puts those under "advice,
not barriers". Keep them there. Relaying forty landmark suggestions as though they were accessibility
failures is the behaviour that makes teams switch the whole check off.

## How to read the answer

There are exactly two kinds of finding, and the difference between them is the whole point:

1. **Barriers** — the element as written stops somebody, and reading it was enough to know that. Each
   names its WCAG 2.2 criterion and level. Report these plainly.
2. **Only a person can settle these** — something is written as an expression, a component, a spread or
   a `<slot />`, so the markup cannot say. These are questions. **Do not relay them as defects, and do
   not resolve them yourself by guessing.** Hand them back as questions, or go and read the code that
   supplies the value.

The report also names the **criteria it did not check** — contrast, focus order, meaningful sequence,
whether the alt text actually describes the picture. Those need a rendered page.

## What you must not say

**Never report that something is accessible.** The tool does not make that claim and neither should you.
A clean result means these checks found nothing. Roughly a third of WCAG can be judged by a machine at
all, and reading source rather than a rendered page reaches less than that.

Say "these checks found no barrier, and here is what they could not check" — then give the list. A team
that believes it has passed when it has only passed the cheap third is worse off than a team with no
tool, because they have stopped looking.

## What to tell the person

Lead with the barriers that stop somebody outright — an unlabelled field, an unnamed button, a control
only a mouse can reach. For each, give the element, the criterion, and the fix the report names.

Then the questions, as questions.

Then, always, what was not checked, and that a person who uses a screen reader is the only way to answer
those. If a fix is wanted, make it: add the label, the `aria-label`, the `alt`. Do not add an `alt=""` to
silence a finding unless the image really is decoration — that converts a reported barrier into a silent
one, which is worse than leaving it.
