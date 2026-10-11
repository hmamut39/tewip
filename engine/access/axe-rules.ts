// Phase 32: what each axe rule tests, taken from axe-core itself.
//
// Lighthouse's accessibility audits are axe rules - the ids are identical - but a Lighthouse report
// does not carry axe's tags, so it says "landmark-one-main" and nothing about which criterion that
// is, or whether it is a criterion at all. Phase 29 needs that to tell a legal failure from somebody's
// good idea, and 42% of axe's output is the latter.
//
// Writing the table by hand was the reason Phase 31 left this undone: a remembered mapping between a
// hundred rule ids and WCAG numbers is a mapping with mistakes in it, and a wrong criterion beside a
// finding is worse than no criterion. So the table is **generated**: axe-core is loaded in a browser
// and asked for its own rule catalogue, and these are its tags, parsed the same way Phase 29 parses
// the tags on a live run.
//
// Generated from axe-core 4.14.0. 105 rules: 75 carry a WCAG criterion,
// 30 are tagged best-practice only and test no standard at all.
// Regenerate with: node scripts/axe-rules.ts - never by editing this file.

export interface AxeRuleFacts {
  /** The WCAG criterion this rule tests, or null when it tests nobody's standard. */
  criterion: string | null;
  level: 'A' | 'AA' | 'AAA' | null;
  /** The clause in EN 301 549, which is what the European Accessibility Act cites. */
  en301549: string | null;
}

export const AXE_CORE_VERSION = '4.14.0';

export const AXE_RULES: Readonly<Record<string, AxeRuleFacts>> = {
  'accesskeys': { criterion: null, level: null, en301549: null },
  'area-alt': { criterion: '2.4.4', level: 'A', en301549: '9.2.4.4' },
  'aria-allowed-attr': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-allowed-role': { criterion: null, level: null, en301549: null },
  'aria-braille-equivalent': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-command-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-conditional-attr': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-deprecated-role': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-dialog-name': { criterion: null, level: null, en301549: null },
  'aria-hidden-body': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'aria-hidden-focus': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-input-field-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-meter-name': { criterion: '1.1.1', level: 'A', en301549: '9.1.1.1' },
  'aria-progressbar-name': { criterion: '1.1.1', level: 'A', en301549: '9.1.1.1' },
  'aria-prohibited-attr': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-required-attr': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-required-children': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'aria-required-parent': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'aria-roledescription': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-roles': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-tab-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-text': { criterion: null, level: null, en301549: null },
  'aria-toggle-field-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-tooltip-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-treeitem-name': { criterion: null, level: null, en301549: null },
  'aria-valid-attr': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'aria-valid-attr-value': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'audio-caption': { criterion: '1.2.1', level: 'A', en301549: '9.1.2.1' },
  'autocomplete-valid': { criterion: '1.3.5', level: 'AA', en301549: '9.1.3.5' },
  'avoid-inline-spacing': { criterion: '1.4.12', level: 'AA', en301549: '9.1.4.12' },
  'blink': { criterion: '2.2.2', level: 'A', en301549: '9.2.2.2' },
  'button-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'bypass': { criterion: '2.4.1', level: 'A', en301549: '9.2.4.1' },
  'color-contrast': { criterion: '1.4.3', level: 'AA', en301549: '9.1.4.3' },
  'color-contrast-enhanced': { criterion: '1.4.6', level: 'AAA', en301549: null },
  'css-orientation-lock': { criterion: '1.3.4', level: 'AA', en301549: '9.1.3.4' },
  'definition-list': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'dlitem': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'document-title': { criterion: '2.4.2', level: 'A', en301549: '9.2.4.2' },
  'duplicate-id': { criterion: '4.1.1', level: null, en301549: null },
  'duplicate-id-active': { criterion: '4.1.1', level: null, en301549: null },
  'duplicate-id-aria': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'empty-heading': { criterion: null, level: null, en301549: null },
  'empty-table-header': { criterion: null, level: null, en301549: null },
  'focus-order-semantics': { criterion: null, level: null, en301549: null },
  'form-field-multiple-labels': { criterion: '3.3.2', level: 'A', en301549: '9.3.3.2' },
  'frame-focusable-content': { criterion: '2.1.1', level: 'A', en301549: '9.2.1.1' },
  'frame-tested': { criterion: null, level: null, en301549: null },
  'frame-title': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'frame-title-unique': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'heading-order': { criterion: null, level: null, en301549: null },
  'hidden-content': { criterion: null, level: null, en301549: null },
  'html-has-lang': { criterion: '3.1.1', level: 'A', en301549: '9.3.1.1' },
  'html-lang-valid': { criterion: '3.1.1', level: 'A', en301549: '9.3.1.1' },
  'html-xml-lang-mismatch': { criterion: '3.1.1', level: 'A', en301549: '9.3.1.1' },
  'identical-links-same-purpose': { criterion: '2.4.9', level: 'AAA', en301549: null },
  'image-alt': { criterion: '1.1.1', level: 'A', en301549: '9.1.1.1' },
  'image-redundant-alt': { criterion: null, level: null, en301549: null },
  'input-button-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'input-image-alt': { criterion: '1.1.1', level: 'A', en301549: '9.1.1.1' },
  'label': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'label-content-name-mismatch': { criterion: '2.5.3', level: 'A', en301549: '9.2.5.3' },
  'label-title-only': { criterion: null, level: null, en301549: null },
  'landmark-banner-is-top-level': { criterion: null, level: null, en301549: null },
  'landmark-complementary-is-top-level': { criterion: null, level: null, en301549: null },
  'landmark-contentinfo-is-top-level': { criterion: null, level: null, en301549: null },
  'landmark-main-is-top-level': { criterion: null, level: null, en301549: null },
  'landmark-no-duplicate-banner': { criterion: null, level: null, en301549: null },
  'landmark-no-duplicate-contentinfo': { criterion: null, level: null, en301549: null },
  'landmark-no-duplicate-main': { criterion: null, level: null, en301549: null },
  'landmark-one-main': { criterion: null, level: null, en301549: null },
  'landmark-unique': { criterion: null, level: null, en301549: null },
  'link-in-text-block': { criterion: '1.4.1', level: 'A', en301549: '9.1.4.1' },
  'link-name': { criterion: '2.4.4', level: 'A', en301549: '9.2.4.4' },
  'list': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'listitem': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'marquee': { criterion: '2.2.2', level: 'A', en301549: '9.2.2.2' },
  'meta-refresh': { criterion: '2.2.1', level: 'A', en301549: '9.2.2.1' },
  'meta-refresh-no-exceptions': { criterion: '2.2.4', level: 'AAA', en301549: null },
  'meta-viewport': { criterion: '1.4.4', level: 'AA', en301549: '9.1.4.4' },
  'meta-viewport-large': { criterion: null, level: null, en301549: null },
  'nested-interactive': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'no-autoplay-audio': { criterion: '1.4.2', level: 'A', en301549: '9.1.4.2' },
  'object-alt': { criterion: '1.1.1', level: 'A', en301549: '9.1.1.1' },
  'p-as-heading': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'page-has-heading-one': { criterion: null, level: null, en301549: null },
  'presentation-role-conflict': { criterion: null, level: null, en301549: null },
  'region': { criterion: null, level: null, en301549: null },
  'role-img-alt': { criterion: '1.1.1', level: 'A', en301549: '9.1.1.1' },
  'scope-attr-valid': { criterion: null, level: null, en301549: null },
  'scrollable-region-focusable': { criterion: '2.1.1', level: 'A', en301549: '9.2.1.1' },
  'select-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'server-side-image-map': { criterion: '2.1.1', level: 'A', en301549: '9.2.1.1' },
  'skip-link': { criterion: null, level: null, en301549: null },
  'summary-name': { criterion: '4.1.2', level: 'A', en301549: '9.4.1.2' },
  'svg-img-alt': { criterion: '1.1.1', level: 'A', en301549: '9.1.1.1' },
  'tabindex': { criterion: null, level: null, en301549: null },
  'table-duplicate-name': { criterion: null, level: null, en301549: null },
  'table-fake-caption': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'target-size': { criterion: '2.5.8', level: 'AA', en301549: '9.2.5.8' },
  'td-has-header': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'td-headers-attr': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'th-has-data-cells': { criterion: '1.3.1', level: 'A', en301549: '9.1.3.1' },
  'valid-lang': { criterion: '3.1.2', level: 'AA', en301549: '9.3.1.2' },
  'video-caption': { criterion: '1.2.2', level: 'A', en301549: '9.1.2.2' },
};

/** What a rule tests, or undefined when axe has no rule by that name. */
export function factsFor(ruleId: string): AxeRuleFacts | undefined {
  return AXE_RULES[ruleId];
}
