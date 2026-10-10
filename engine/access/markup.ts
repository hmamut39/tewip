// Phase 28: reading markup well enough to be honest about it.
//
// This is not an HTML parser and does not try to be. It is a tolerant tag scanner over the four
// shapes a real project writes its interface in - HTML, JSX/TSX, Vue and Svelte templates - and its
// one job is to know *when it does not know*. An attribute whose value is an expression
// (`alt={caption}`), an element carrying a spread (`<img {...props} />`), a component rather than an
// element (`<Image />`): in every one of those the markup alone cannot say whether a barrier exists,
// and the scanner says so rather than guessing. That refusal is the whole reason this is worth
// shipping; a tool that accuses `<img alt={alt} />` of having no alt text gets switched off in a day.
//
// Everything here is deterministic and costs nothing: no browser, no network, no model.

/** One element as it was written, with what could and could not be read from it. */
export interface Tag {
  /** Lowercased element name: `img`, `div`. Components keep their case in `component`. */
  name: string;
  /** True when the name began with a capital or contained a dot: a component, not an element. */
  component: boolean;
  /** Attributes whose value could actually be read, lowercased name to literal value. */
  attrs: Record<string, string>;
  /** Attributes present but written as an expression, so the value is unknown. */
  dynamic: Set<string>;
  /** `<img {...props} />` - any attribute at all may be set, so nothing can be ruled out. */
  spread: boolean;
  closing: boolean;
  selfClosing: boolean;
  line: number;
  /** Character offsets of the tag in the source, for reading the text inside an element. */
  start: number;
  end: number;
}

/**
 * Elements HTML closes for you. A scanner that expects `</img>` pairs everything wrong from the
 * first image onwards, which is how naive checkers end up reporting a button as empty.
 */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * A tag, with the three attribute-value shapes that appear in practice kept apart from `>` so an
 * expression containing a greater-than sign does not end the tag early.
 */
// The lookahead after the name is load-bearing: a real tag is followed by whitespace, `/` or `>`.
// Without it `/<!doctype html|<html[\s>]/i` - a regex literal in excalidraw's App.tsx - parsed as an
// <html> element and was reported as a page with no lang attribute.
// The attribute group is lazy on purpose. Greedy, it absorbs the `/` of `<button ... />` into the
// attributes, the element is recorded as still open, and the next sibling control is reported as
// nested inside it. Quoted and braced values are matched as whole units in the alternation, so
// laziness cannot stop at a `>` that lives inside one.
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9._:-]*)(?=[\s/>])((?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*?)(\/?)>/g;

const ATTRIBUTE =
  /([@:#\[A-Za-z_][-A-Za-z0-9_:.@\]]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}|([^\s"'<>`=]+)))?/g;

/** `{...props}`, `{...rest}` - the thing that makes every other judgement about the element unsafe. */
const SPREAD = /\{\s*\.\.\./;

/**
 * Comments, and the bodies of script and style, hold things shaped like tags that are not tags.
 *
 * `jsLike` additionally blanks template literals, which is not optional in a .tsx file: real
 * projects build HTML in backtick strings - an iframe's srcDoc, an email body, a test fixture - and
 * reading those as the page's own markup produces findings about code that no browser ever renders
 * as part of this component. Found on excalidraw, whose AI.tsx holds an entire error page in a
 * template literal and was reported as a page with no lang attribute.
 *
 * Blanking rather than scanning is the conservative choice: a string may be a page, or it may be a
 * SQL query, a documentation sample or an assertion. Tewip does not guess which.
 */
function withoutNonMarkup(source: string, jsLike: boolean): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const stripped = source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, blank)
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, blank);
  return jsLike ? stripped.replace(/`(?:[^`\\]|\\[\s\S])*`/g, blank) : stripped;
}

/** Files whose markup is embedded in JavaScript, where a backtick string is not page markup. */
export const JS_LIKE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;

function readAttributes(blob: string): Pick<Tag, 'attrs' | 'dynamic' | 'spread'> {
  const attrs: Record<string, string> = {};
  const dynamic = new Set<string>();
  const spread = SPREAD.test(blob);
  // A spread's contents would otherwise be read as attribute names: `{...props}` becomes `props`.
  const readable = blob.replace(/\{\s*\.\.\.(?:[^{}]|\{[^{}]*\})*\}/g, ' ');
  for (const m of readable.matchAll(ATTRIBUTE)) {
    // A bound attribute is the same attribute. Vue writes `:aria-label="label"` and
    // `v-bind:title="t"`, Angular writes `[attr.aria-label]="l"`, and reading those names
    // literally means the element looks as though it has no label at all - which reported eight
    // perfectly well-labelled buttons in vitepress as unnamed. The value is an expression, so the
    // attribute is present but unreadable: that is `dynamic`, which asks rather than accuses.
    const written = m[1].toLowerCase();
    const binding = /^(?::|v-bind:|\[attr\.|\[)/.exec(written);
    const name = binding ? written.slice(binding[0].length).replace(/\]$/, '') : written;
    const quoted = m[2] ?? m[3] ?? m[5];
    const expression = m[4];
    if (binding && name !== '') {
      dynamic.add(name);
      continue;
    }
    if (expression !== undefined) {
      // A literal inside braces is still a literal: alt={"a cat"} and alt={''} are both readable.
      const literal = /^\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*$/.exec(expression);
      if (literal) attrs[name] = literal[1] ?? literal[2] ?? literal[3] ?? '';
      else dynamic.add(name);
      continue;
    }
    attrs[name] = quoted ?? '';
  }
  return { attrs, dynamic, spread };
}

/** Every tag in a file, in source order. `jsLike` says to ignore template literals. */
export function tags(source: string, jsLike = false): Tag[] {
  const text = withoutNonMarkup(source, jsLike);
  const out: Tag[] = [];
  let line = 1;
  let read = 0;
  for (const m of text.matchAll(TAG)) {
    const at = m.index;
    for (let i = read; i < at; i++) if (text[i] === '\n') line++;
    read = at;
    const raw = m[2];
    const name = raw.toLowerCase();
    out.push({
      name,
      component: /^[A-Z]/.test(raw) || raw.includes('.'),
      ...readAttributes(m[3]),
      closing: m[1] === '/',
      selfClosing: m[4] === '/' || VOID.has(name),
      line,
      start: at,
      end: at + m[0].length,
    });
  }
  return out;
}

/**
 * The text a person would hear inside an element, with anything unreadable reported separately.
 *
 * "Unreadable" is doing real work here: `<button>{label}</button>` has a name at runtime and
 * `<button><Icon /></button>` may or may not. Both must be refused rather than called empty.
 */
export interface Inside {
  /** Literal text, whitespace collapsed. */
  text: string;
  /** An expression, a component, or an image whose alt could not be read. */
  unreadable: boolean;
  /** The tags between the open and close, for checks that look deeper. */
  within: Tag[];
}

/** Reads what is inside the element opened by `tags[index]`, pairing tags with a depth count. */
export function inside(source: string, all: Tag[], index: number): Inside {
  const open = all[index];
  if (open.selfClosing || open.closing) return { text: '', unreadable: false, within: [] };
  let depth = 1;
  let close = -1;
  const within: Tag[] = [];
  for (let i = index + 1; i < all.length; i++) {
    const t = all[i];
    if (t.name === open.name && !t.selfClosing) depth += t.closing ? -1 : 1;
    if (depth === 0) {
      close = i;
      break;
    }
    within.push(t);
  }
  // No closing tag found: the file is a fragment, or the markup is broken. Either way, refuse.
  if (close === -1) return { text: '', unreadable: true, within };

  const between = source.slice(open.end, all[close].start);
  const literal = between
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const expressions = /\{(?:[^{}]|\{[^{}]*\})*\}/.test(between);
  // An image inside a link or button *is* its accessible name when it has alt text. A logo link
  // written `<a href="/"><img src="logo.png" alt="Home"></a>` is the commonest shape on the web,
  // and reporting it as an unnamed link would be wrong on nearly every site there is.
  const alts = within
    .filter((t) => t.name === 'img' && typeof t.attrs.alt === 'string' && t.attrs.alt.trim() !== '')
    .map((t) => t.attrs.alt.trim());
  // `<slot />` is Vue's and Svelte's `{children}`: whatever is inside comes from whoever used this
  // component, so the markup here cannot say whether the control ends up named. vitepress's
  // VPSwitch is exactly that shape and was being accused rather than asked about.
  const unknownChild = within.some((t) => t.component || t.name === 'slot' || t.dynamic.size > 0 || t.spread);
  const text = [literal, ...alts].filter((s) => s !== '').join(' ');
  return { text, unreadable: expressions || (unknownChild && alts.length === 0), within };
}

/** The accessible name an element carries on its own attributes, if one can be read. */
export function labelledBy(tag: Tag): { named: boolean; unknown: boolean } {
  const explicit = ['aria-label', 'aria-labelledby', 'title', 'alt'];
  for (const a of explicit) {
    if (tag.dynamic.has(a)) return { named: false, unknown: true };
    const v = tag.attrs[a];
    if (typeof v === 'string' && v.trim() !== '') return { named: true, unknown: false };
  }
  if (tag.spread) return { named: false, unknown: true };
  return { named: false, unknown: false };
}

/** Files whose markup this scanner reads. */
export const MARKUP = /\.(?:html?|jsx|tsx|vue|svelte|astro|erb|php)$/i;
