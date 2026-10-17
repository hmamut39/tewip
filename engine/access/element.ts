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
/**
 * A click handler, in any of the spellings the frameworks use.
 *
 * This was a list of four exact names, and two whole frameworks wrote theirs differently:
 *
 *   - **Angular** binds events as `(click)="..."`. angular/components has **414** of them and Tewip
 *     saw none, so `click-without-keyboard` could never fire in any Angular project at all. The
 *     library reported zero, which looked like a clean result and was blindness.
 *   - **Vue** allows modifiers, so the attribute is `@click.stop` or `@click.prevent` rather than
 *     `@click`. nocodb has **455** of those.
 *
 * Svelte was already covered both ways - `on:click` and Svelte 5's `onclick` - which is why this
 * only showed up when a third framework was finally pointed at.
 *
 * `keyHandler` below had no such problem because it matches on a substring; the trade is that this
 * one has to name the shapes, so that `data-click-target` is not read as a handler.
 */
// Angular's `(click)="go()"` reaches here as an attribute plainly named `click`, because the
// attribute reader strips the parentheses - which is also why `keyHandler` below already worked for
// Angular and this did not: it matches on a substring and this matched on an exact name. No standard
// HTML attribute is called `click`, so taking the bare form costs nothing.
const CLICK = /^(?:on)?(?:click|dblclick)$|^(?:@|v-on:|on:)(?:click|dblclick)(?:[.|][\w.|$-]*)?$/i;

/**
 * A custom element: a component in markup that does not spell its name with a capital.
 *
 * `t.component` catches React's `<Select>` and `<Foo.Bar>`, and misses every web component and every
 * Angular or Ionic element - `<mat-checkbox>`, `<mat-list-item>`, `<ion-button>`. A dash in the name
 * is what the HTML spec reserves for them, and no standard element has one.
 *
 * It matters wherever Tewip is about to say something certain about an element whose behaviour is
 * written somewhere else. `<mat-checkbox (click)="x()">` is a real checkbox with real keyboard
 * handling once Angular renders it; reading the markup alone it looks like a bare tag with a click.
 */
export function customElement(t: Tag): boolean {
  return t.name.includes('-');
}

export function clickHandler(t: Tag): boolean {
  return [...Object.keys(t.attrs), ...t.dynamic].some((a) => CLICK.test(a));
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
