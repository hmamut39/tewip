// Phase 28: the catalogue. Which success criterion each check belongs to, how much it matters, and
// - the part no other tool writes down - which criteria this check deliberately does not touch.
//
// Why the criterion numbers are here at all: accessibility is the one quality question that is also
// a legal one. The European Accessibility Act has been enforceable since June 2025 and the US
// Section 508 and ADA rules point at the same standard, WCAG 2.2 level AA. A finding a team can
// trace to a numbered criterion is a finding they can put in front of a lawyer or a regulator; a
// finding that only says "bad contrast" is not. So every rule carries its criterion and its level.

export type Severity = 'blocker' | 'serious' | 'moderate' | 'minor';

/**
 * How sure the markup alone can be.
 *
 * `barrier`      the element as written stops somebody, and reading it is enough to know that;
 * `ask-a-person` something is missing or unreadable here and only a person can settle it.
 *
 * There is no third option on purpose. Tewip does not have a "warning" that a team learns to scroll
 * past - either it is making an accusation it can defend, or it is asking a question.
 */
export type Confidence = 'barrier' | 'ask-a-person';

export interface Rule {
  criterion: string;
  /** A, AA or AAA. Teams are usually held to AA. */
  level: 'A' | 'AA' | 'AAA';
  severity: Severity;
  /** Who this actually stops, in plain words. Not a restatement of the rule. */
  stops: string;
}

export const RULES: Record<string, Rule> = {
  'image-alt': {
    criterion: '1.1.1 Non-text Content',
    level: 'A',
    severity: 'blocker',
    stops: 'a screen reader reads the file name instead of the picture, or says nothing at all',
  },
  'input-label': {
    criterion: '3.3.2 Labels or Instructions',
    level: 'A',
    severity: 'blocker',
    stops: 'a screen reader announces "edit text" with no way to know what to type',
  },
  'button-name': {
    criterion: '4.1.2 Name, Role, Value',
    level: 'A',
    severity: 'blocker',
    stops: 'a screen reader announces "button" and nothing else, so it cannot be used or spoken to',
  },
  'link-name': {
    criterion: '2.4.4 Link Purpose',
    level: 'A',
    severity: 'blocker',
    stops: 'a screen reader lists the page links as "link, link, link"',
  },
  'html-lang': {
    criterion: '3.1.1 Language of Page',
    level: 'A',
    severity: 'serious',
    stops: 'a screen reader reads the page in the wrong accent, which can make it unintelligible',
  },
  'click-without-keyboard': {
    criterion: '2.1.1 Keyboard',
    level: 'A',
    severity: 'blocker',
    stops: 'anyone who cannot use a mouse, including every screen reader user, cannot activate it',
  },
  'positive-tabindex': {
    criterion: '2.4.3 Focus Order',
    level: 'A',
    severity: 'serious',
    stops: 'the tab key jumps around the page in an order that does not match what is on screen',
  },
  'nested-interactive': {
    criterion: '4.1.2 Name, Role, Value',
    level: 'A',
    severity: 'serious',
    stops: 'a control inside a control is announced and operated unpredictably, and often cannot be reached',
  },
  'iframe-title': {
    criterion: '4.1.2 Name, Role, Value',
    level: 'A',
    severity: 'serious',
    stops: 'a screen reader announces an unnamed frame with no clue what is inside it',
  },
  'zoom-blocked': {
    criterion: '1.4.4 Resize Text',
    level: 'AA',
    severity: 'serious',
    stops: 'anyone with low vision cannot pinch to zoom the page on a phone',
  },
  'autoplay-sound': {
    criterion: '1.4.2 Audio Control',
    level: 'A',
    severity: 'serious',
    stops: 'sound plays over a screen reader, which makes the page unusable while it runs',
  },
  'duplicate-id': {
    criterion: '4.1.1 Parsing',
    level: 'A',
    severity: 'moderate',
    stops: 'a label or description points at the wrong element, so the wrong thing is announced',
  },
  'heading-skip': {
    criterion: '1.3.1 Info and Relationships',
    level: 'A',
    severity: 'moderate',
    stops: 'a screen reader user navigating by heading cannot tell how the page is organised',
  },
  'aria-unknown': {
    criterion: '4.1.2 Name, Role, Value',
    level: 'A',
    severity: 'moderate',
    stops: 'nothing - a misspelled aria attribute is silently ignored, so the help it was meant to give never arrives',
  },
  'aria-hidden-focusable': {
    criterion: '4.1.2 Name, Role, Value',
    level: 'A',
    severity: 'serious',
    stops: 'the tab key lands on something a screen reader has been told does not exist',
  },
};

/**
 * What reading markup cannot settle, said plainly so nobody mistakes a clean run for a pass.
 *
 * This list is the honest half of the command. Roughly a third of WCAG is machine-checkable at all,
 * and a scanner reading source rather than a rendered page checks less than that. Printing this
 * every time is what stops "Tewip found no barriers" from being heard as "this is accessible".
 */
export const NOT_CHECKED: ReadonlyArray<{ criterion: string; why: string; settledBy?: string }> = [
  {
    criterion: '1.4.3 Contrast (Minimum)',
    why: 'needs the computed colours of a rendered page, not the markup',
    // The one entry on this list a browser run genuinely closes (Phase 29).
    settledBy: 'color-contrast',
  },
  // Everything below has no `settledBy` on purpose, and must not acquire one because a tool
  // reports something under the same criterion number. axe's `image-alt` checks that an alt
  // attribute exists; it has no opinion on whether the words describe the picture, which is the
  // part named here. Matching on the number alone briefly made Tewip claim it had checked alt-text
  // quality and timing behaviour, which no tool can.
  { criterion: '1.1.1 Non-text Content, quality', why: 'whether alt text actually describes the picture is a human judgement' },
  { criterion: '2.4.7 Focus Visible', why: 'needs a rendered page to see whether the focus ring survives the stylesheet' },
  { criterion: '1.3.2 Meaningful Sequence', why: 'needs the rendered order, which CSS can change from the source order' },
  { criterion: '4.1.3 Status Messages', why: 'needs a running page to observe what a live region announces' },
  { criterion: '2.2.1 Timing Adjustable', why: 'needs the running behaviour of timeouts' },
  { criterion: '3.2.x Predictable', why: 'needs a person to use the page and judge it' },
];

/** Rules whose finding, on its own, should stop a release. */
export function blocks(rule: string): boolean {
  return RULES[rule]?.severity === 'blocker';
}

/** `1.1.1 Non-text Content (A)` - how a finding names its criterion in a report. */
export function criterionOf(rule: string): string {
  const r = RULES[rule];
  return r ? `WCAG 2.2 ${r.criterion} (${r.level})` : 'WCAG 2.2';
}
