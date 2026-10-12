// What a single element is: decorative, interactive, hidden, named by its type.
//
// Split out of checks.ts in Phase 43, when the Keycloak trial added two of these - `hiddenFromEveryone`
// and the component guard - and pushed that file past the 300-line rule. These are the questions
// asked of one tag with no knowledge of the document around it, which is exactly the set that was
// easiest to lift out whole.
import type { Tag } from './markup.ts';
import type { Finding } from './checks.ts';

/** Elements that already answer to the keyboard and already carry a role. */
export const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'details']);

/** `role="presentation"` and friends: the author has said this is decoration. */
export function decorative(t: Tag): boolean {
  return t.attrs['aria-hidden'] === 'true' || t.attrs.role === 'presentation' || t.attrs.role === 'none';
}

export function show(t: Tag): string {
  const keep = ['src', 'href', 'type', 'name', 'id', 'class', 'role'];
  const shown = keep
    .filter((k) => typeof t.attrs[k] === 'string' && t.attrs[k] !== '')
    .slice(0, 2)
    .map((k) => ` ${k}="${t.attrs[k].slice(0, 40)}"`)
    .join('');
  return `<${t.name}${shown}${t.spread ? ' {...}' : ''}>`;
}

export function at(t: Tag, file: string): Pick<Finding, 'file' | 'line' | 'element'> {
  return { file, line: t.line, element: show(t) };
}

/** Every real `aria-*` attribute. A name outside this set is a typo, and a typo does nothing at all. */
export const ARIA = new Set([
  'aria-activedescendant', 'aria-atomic', 'aria-autocomplete', 'aria-braillelabel', 'aria-brailleroledescription',
  'aria-busy', 'aria-checked', 'aria-colcount', 'aria-colindex', 'aria-colindextext', 'aria-colspan',
  'aria-controls', 'aria-current', 'aria-describedby', 'aria-description', 'aria-details', 'aria-disabled',
  'aria-dropeffect', 'aria-errormessage', 'aria-expanded', 'aria-flowto', 'aria-grabbed', 'aria-haspopup',
  'aria-hidden', 'aria-invalid', 'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-level', 'aria-live',
  'aria-modal', 'aria-multiline', 'aria-multiselectable', 'aria-orientation', 'aria-owns', 'aria-placeholder',
  'aria-posinset', 'aria-pressed', 'aria-readonly', 'aria-relevant', 'aria-required', 'aria-roledescription',
  'aria-rowcount', 'aria-rowindex', 'aria-rowindextext', 'aria-rowspan', 'aria-selected', 'aria-setsize',
  'aria-sort', 'aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext',
]);

/** A click handler, in any of the four dialects this scanner reads. */
export function clickHandler(t: Tag): boolean {
  return ['onclick', '@click', 'v-on:click', 'on:click'].some((a) => a in t.attrs || t.dynamic.has(a));
}

export function keyHandler(t: Tag): boolean {
  return Object.keys(t.attrs).concat([...t.dynamic]).some((a) => /key(down|up|press)/i.test(a));
}

export function tabIndexOf(t: Tag): number | null {
  const raw = t.attrs.tabindex ?? t.attrs.tabIndex;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fields that take typing, and therefore need a label. Buttons and hidden fields are excluded: a
 * submit button is named by its value, and a hidden field is not announced at all.
 */
export const UNLABELLED_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);


/**
 * Hidden from everybody, so no name is needed and none is missing.
 *
 * A file picker styled out of sight and clicked by a button beside it is the standard way to build
 * an upload control, and Keycloak's `<input id="jarUpload" type="file" style={{display:"none"}}>` is
 * exactly that. `display:none` takes an element out of the accessibility tree altogether: it is
 * announced to nobody, so "it has no label" stops nobody either.
 *
 * When the style is a JSX expression its text is not kept, so whether it hides the element cannot be
 * read. That is not a reason to call it a certain barrier - it is a reason to say so.
 */
/**
 * Not rendered at all, and therefore not in the tab order either.
 *
 * Separate from `hiddenFromEveryone` because `aria-hidden` hides an element from a screen reader
 * while leaving it perfectly focusable - that gap is a real barrier and has its own rule. The
 * `hidden` attribute and `display:none` close the gap: nothing can reach the element by any route.
 */
export function notRendered(t: Tag): boolean {
  if ('hidden' in t.attrs && t.attrs.hidden !== 'false') return true;
  const style = typeof t.attrs.style === 'string' ? t.attrs.style : '';
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

export function hiddenFromEveryone(t: Tag): boolean {
  if (notRendered(t)) return true;
  if (t.attrs['aria-hidden'] === 'true') return true;
  const style = typeof t.attrs.style === 'string' ? t.attrs.style : '';
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}
