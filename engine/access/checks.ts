// Phase 28: the checks. Each one is deterministic, each one names the element it is talking about,
// and each one has a shape it refuses rather than guesses on.
//
// The restraint matters more than the coverage. These are the barriers that can be decided by
// reading the markup - a picture with no alt attribute at all, a field with no label anywhere, a
// div that only answers to a mouse. The ones that need a rendered page (contrast, focus order,
// whether alt text is any good) are not attempted here and are listed in NOT_CHECKED instead.
import { inside, labelledBy, type Tag } from './markup.ts';
import type { Confidence } from './wcag.ts';
import { ARIA, INTERACTIVE, UNLABELLED_TYPES, at, clickHandler, decorative, hiddenFromEveryone, keyHandler, show, tabIndexOf } from './element.ts';

export interface Finding {
  rule: string;
  confidence: Confidence;
  file: string;
  line: number;
  /** The element as written, shortened: `<img src="logo.png">`. */
  element: string;
  /** Why this verdict, checkable against the element. */
  why: string;
  next: string;
}

/** Checks that look at one element at a time. */
function perElement(t: Tag, file: string, labelFor: Set<string>, openLabels: number, ancestorKey: boolean, namedByComponent: Set<string> = new Set()): Finding[] {
  const out: Finding[] = [];
  const place = at(t, file);
  const name = labelledBy(t);

  if (t.name === 'img' && !t.component) {
    if (decorative(t)) {
      // Said to be decoration. That is a legitimate choice and not Tewip's to second-guess.
    } else if ('alt' in t.attrs || t.dynamic.has('alt')) {
      // An alt attribute is present. Whether its words are any good is in NOT_CHECKED.
    } else if (t.spread) {
      out.push({ rule: 'image-alt', confidence: 'ask-a-person', ...place,
        why: 'no alt attribute is written here, but the element carries a spread, so alt may come from the props',
        next: 'check what is spread in; if alt is not among it, add alt, or alt="" if the image is decoration' });
    } else {
      out.push({ rule: 'image-alt', confidence: 'barrier', ...place,
        why: 'no alt attribute at all, and nothing marks the image as decoration',
        next: 'add alt="..." describing what the image conveys, or alt="" if it conveys nothing' });
    }
  }

  // A <select> and a <textarea> need a name exactly as much as an <input> does, and this checked
  // only <input>. A screen reader announces an unnamed select as "combo box" and stops - the user is
  // told there is a choice to make and nothing about what it decides. Found in Phase 43 by putting a
  // deliberately broken React component in front of the scanner: it caught the bare <img>, <input>,
  // <button>, <a> and click-only <div>, and walked straight past <select>. `select-name` was already
  // in the axe rule table and already in INTERACTIVE; only this line had never been widened.
  const NEEDS_NAME: Record<string, string> = { input: 'input-label', select: 'select-name', textarea: 'label' };
  const nameRule = NEEDS_NAME[t.name];
  // `!t.component` matters as much as the element name. React names its components with a capital,
  // so PatternFly's `<Select>` and `<Input>` lowercase to the same string as the HTML elements - and
  // this check, unlike `image-alt` beside it, never asked. Keycloak's admin UI is built on PatternFly
  // and `<Select onOpenChange={...}>` was reported as an unnamed combo box; what that component
  // renders, and whether it labels itself, is not in this file and cannot be read from it.
  if (nameRule && !t.component && !hiddenFromEveryone(t) && (t.name !== 'input' || !UNLABELLED_TYPES.has(t.attrs.type ?? 'text'))) {
    const linked = typeof t.attrs.id === 'string' && labelFor.has(t.attrs.id);
    if (!name.named && !linked && openLabels === 0) {
      if (name.unknown || t.dynamic.has('id') || t.dynamic.has('style') || (typeof t.attrs.id === 'string' && namedByComponent.has(t.attrs.id))) {
        out.push({ rule: nameRule, confidence: 'ask-a-person', ...place,
          why:
            typeof t.attrs.id === 'string' && namedByComponent.has(t.attrs.id)
              ? `no <label for> is written here, but a component in this file names id="${t.attrs.id}" in one of its props, so the label may be rendered there`
              : t.dynamic.has('style')
                ? 'no label can be read here, and its style is an expression, so whether this is displayed at all cannot be read from the markup'
              : 'no label, aria-label or wrapping <label> can be read here, and part of the element is an expression',
          next: 'confirm the field is labelled at runtime; if not, add aria-label or a <label for>' });
      } else {
        out.push({ rule: nameRule, confidence: 'barrier', ...place,
          why: 'no aria-label, no title, no id matching a <label for>, and not inside a <label>',
          next: 'wrap it in a <label>, or give it an id and point a <label for> at it' });
      }
    }
  }

  if (t.name === 'iframe' && !name.named && !decorative(t)) {
    out.push({ rule: 'iframe-title', confidence: name.unknown ? 'ask-a-person' : 'barrier', ...place,
      why: 'an iframe with no title and no aria-label',
      next: 'add title="..." saying what the frame contains' });
  }

  const tabindex = tabIndexOf(t);
  if (tabindex !== null && tabindex > 0) {
    out.push({ rule: 'positive-tabindex', confidence: 'barrier', ...place,
      why: `tabindex="${tabindex}" takes this element out of the document order and puts it before everything that has none`,
      next: 'use tabindex="0" and let the source order decide, or move the element in the markup' });
  }

  if (t.attrs['aria-hidden'] === 'true' && (INTERACTIVE.has(t.name) || (tabindex !== null && tabindex >= 0))) {
    out.push({ rule: 'aria-hidden-focusable', confidence: 'barrier', ...place,
      why: 'hidden from screen readers but still reachable by the tab key',
      next: 'also remove it from the tab order with tabindex="-1", or stop hiding it' });
  }

  // `ancestorKey`: an enclosing element already handles keys, which is how every dialog in the
  // world is built - a backdrop div closes on click, and Escape closes it from the dialog itself.
  // WCAG 2.1.1 asks that the *function* be reachable from the keyboard, not that this particular
  // div be focusable. Excalidraw's Modal.tsx is exactly this shape, and calling it a blocker is wrong.
  if (clickHandler(t) && !INTERACTIVE.has(t.name) && !t.component && !t.attrs.role && tabindex === null && !keyHandler(t) && !ancestorKey) {
    out.push({ rule: 'click-without-keyboard', confidence: 'barrier', ...place,
      why: 'it responds to a click, but it has no role, no tabindex and no key handler, so the keyboard cannot reach or fire it',
      next: 'use a <button>, or add role="button", tabindex="0" and a key handler' });
  }

  if ((t.name === 'video' || t.name === 'audio') && 'autoplay' in t.attrs && !('muted' in t.attrs)) {
    out.push({ rule: 'autoplay-sound', confidence: 'barrier', ...place,
      why: 'it plays on load and is not muted, so it talks over a screen reader',
      next: 'add muted, or remove autoplay and let the person press play' });
  }

  if (t.name === 'meta' && (t.attrs.name ?? '').toLowerCase() === 'viewport') {
    const content = (t.attrs.content ?? '').toLowerCase();
    const max = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
    if (/user-scalable\s*=\s*(no|0)/.test(content) || (max && Number(max[1]) < 2)) {
      out.push({ rule: 'zoom-blocked', confidence: 'barrier', ...place,
        why: `the viewport meta tag prevents zooming: ${content}`,
        next: 'drop user-scalable=no and maximum-scale, or set maximum-scale to at least 2' });
    }
  }

  for (const a of Object.keys(t.attrs).concat([...t.dynamic])) {
    if (a.startsWith('aria-') && !ARIA.has(a)) {
      out.push({ rule: 'aria-unknown', confidence: 'barrier', ...place,
        why: `${a} is not an ARIA attribute, so it is ignored entirely and whatever it was meant to do does not happen`,
        next: 'correct the spelling, or remove it' });
    }
  }

  return out;
}

/**
 * Everything that needs more than one element: names from content, nesting, ids, heading order.
 *
 * `isDocument` says this file is one page. It is false for a component file, and that distinction
 * decides whether duplicate ids mean anything: excalidraw's icons.tsx holds fifty separate SVG
 * icons, each with its own `<clipPath id="a">`, and they are never in one document together. A
 * check that calls that a defect is wrong fifty times in one file.
 */
export function checkFile(source: string, all: Tag[], file: string, isDocument = false): Finding[] {
  const out: Finding[] = [];
  const labelFor = new Set(all.filter((t) => t.name === 'label' && t.attrs.for).map((t) => t.attrs.for));
  // Ids that a *component* names in one of its props. A design system labels a field by being told
  // which field it is for - PatternFly's `<FormGroup label={...} fieldId="x">` renders `<label for="x">`
  // around its children - and that label exists only in the component's own source, not here.
  // Keycloak's admin UI is built this way throughout, so a control inside one is not an unnamed
  // control; it is a control this file cannot answer for, which is a different verdict.
  const namedByComponent = new Set<string>();
  for (const t of all) {
    if (!t.component) continue;
    for (const [key, value] of Object.entries(t.attrs)) {
      if (typeof value === 'string' && value !== '' && /(^|[a-z])(id|for)$/i.test(key)) namedByComponent.add(value);
    }
  }
  const seenIds = new Set<string>();
  let openLabels = 0;
  let interactiveDepth = 0;
  let lastHeading = 0;

  /** The elements currently open around this one, and whether each handles keys. */
  const open: { name: string; keys: boolean }[] = [];

  for (const [i, t] of all.entries()) {
    if (t.name === 'label') openLabels += t.closing ? -1 : t.selfClosing ? 0 : 1;
    if (t.closing) {
      if (INTERACTIVE.has(t.name) && interactiveDepth > 0) interactiveDepth--;
      // Unwind to the matching open element, tolerating markup that never closed it.
      const from = open.map((o) => o.name).lastIndexOf(t.name);
      if (from !== -1) open.length = from;
      continue;
    }

    out.push(...perElement(t, file, labelFor, Math.max(openLabels - (t.name === 'label' ? 1 : 0), 0), open.some((o) => o.keys), namedByComponent));
    if (!t.selfClosing) open.push({ name: t.name, keys: keyHandler(t) });

    const id = t.attrs.id;
    if (isDocument && id && !t.dynamic.has('id')) {
      if (seenIds.has(id)) {
        out.push({ rule: 'duplicate-id', confidence: 'barrier', ...at(t, file),
          why: `id="${id}" is used more than once in this file, so anything pointing at it reaches only the first`,
          next: 'make the ids unique' });
      }
      seenIds.add(id);
    }

    const heading = /^h([1-6])$/.exec(t.name);
    if (heading) {
      const level = Number(heading[1]);
      if (lastHeading > 0 && level > lastHeading + 1) {
        out.push({ rule: 'heading-skip', confidence: 'barrier', ...at(t, file),
          why: `h${level} follows h${lastHeading}, so a level is missing from the outline`,
          next: `use h${lastHeading + 1} here, or add the missing heading above it` });
      }
      lastHeading = level;
    }

    // A name from content: a button or link whose text is the only thing announcing it.
    if ((t.name === 'button' || (t.name === 'a' && ('href' in t.attrs || t.dynamic.has('href')))) && !t.component) {
      const label = labelledBy(t);
      if (!label.named) {
        const body = inside(source, all, i);
        const rule = t.name === 'button' ? 'button-name' : 'link-name';
        if (body.text !== '') {
          // Named by its own text. Nothing to say.
        } else if (label.unknown || body.unreadable) {
          out.push({ rule, confidence: 'ask-a-person', ...at(t, file),
            why: 'its name would come from content this scanner cannot read - an expression, a component, or an image whose alt is set elsewhere',
            next: 'check what it announces with a screen reader; if it is silent, add aria-label' });
        } else {
          out.push({ rule, confidence: 'barrier', ...at(t, file),
            why: 'it contains no text and carries no aria-label, so it is announced with its role and nothing else',
            next: 'put text inside it, or add aria-label="..." saying what it does' });
        }
      }
      if (interactiveDepth > 0) {
        out.push({ rule: 'nested-interactive', confidence: 'barrier', ...at(t, file),
          why: 'a link or button inside another link or button',
          next: 'move it out, so the two controls are siblings rather than nested' });
      }
      if (!t.selfClosing) interactiveDepth++;
    }
  }

  const html = all.find((t) => t.name === 'html' && !t.closing);
  if (html && !('lang' in html.attrs) && !html.dynamic.has('lang')) {
    out.push({ rule: 'html-lang', confidence: 'barrier', ...at(html, file),
      why: 'the <html> element has no lang attribute, so a screen reader guesses the language',
      next: 'add lang="en", or whichever language the page is written in' });
  }

  return out;
}
