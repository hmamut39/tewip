// A Figma frame, turned into checks that can be verified against a running page.
//
// Three kinds of check, and nothing else. A design says which words are on the screen; through the
// names designers give their layers and components it says which things are buttons, fields and
// links; and through the names of its big sections it says the page has a navigation, a header, a
// main area and a footer. It does not say what the markup looks like, so Tewip never claims anything
// about pixels, colours, spacing or CSS. A check Tewip cannot verify honestly is not written.
//
// The naming rules below were checked against Figma API dumps from fifteen public repositories
// rather than invented: real files name things "Button", "button", "Button__Active", "CTA Button",
// "Nav", "Footer" and "Link inline", and Tewip has to read all of those.
import type { FigmaNode } from './figma.ts';
import { walk } from './figma.ts';

export interface DesignCheck {
  /** 'role': a control with this accessible name. 'text': these words appear. 'landmark': the page
   *  has a region of this kind, which has no name to check. */
  kind: 'role' | 'text' | 'landmark';
  /** The ARIA role the design implies, for a role or landmark check. */
  role?: string;
  /** The accessible name, or the words themselves for a text check. Empty for a landmark. */
  name: string;
  /** Where in the design it came from, so a person can find it: the layer path. */
  from: string;
}

/**
 * Layer and component names that say what a thing is. Designers name things for other designers, so
 * these are the words they actually use; anything not listed here becomes a text check instead of a
 * wrong guess about a role.
 */
const ROLE_WORDS: Array<[RegExp, string]> = [
  [/(?:^|[^a-z])(?:icon[- _]?button|button|btn|cta)(?:[^a-z]|$)/i, 'button'],
  [/(?:^|[^a-z])(?:text[- _]?field|textfield|input|form[- _]?field|search[- _]?field)(?:[^a-z]|$)/i, 'textbox'],
  [/(?:^|[^a-z])(?:search[- _]?bar|searchbox)(?:[^a-z]|$)/i, 'searchbox'],
  [/(?:^|[^a-z])(?:hyperlink|link)(?:[^a-z]|$)/i, 'link'],
  [/(?:^|[^a-z])checkbox(?:[^a-z]|$)/i, 'checkbox'],
  [/(?:^|[^a-z])radio(?:[- _]?button)?(?:[^a-z]|$)/i, 'radio'],
  [/(?:^|[^a-z])(?:toggle|switch)(?:[^a-z]|$)/i, 'switch'],
  [/(?:^|[^a-z])(?:dropdown|select|combo[- _]?box|picker)(?:[^a-z]|$)/i, 'combobox'],
  [/(?:^|[^a-z])tab(?:[^a-z]|$)/i, 'tab'],
  [/(?:^|[^a-z])(?:h[1-6]|heading|headline|page[- _]?title)(?:[^a-z]|$)/i, 'heading'],
];

/**
 * Regions a design names, which a loaded page should really have. Kept to the four that are on the
 * screen the moment a page opens: a modal or a drawer is drawn in the design but hidden in the
 * page, and reporting those as missing would be noise.
 */
const LANDMARKS: Array<[RegExp, string]> = [
  [/^(?:nav|navbar|navigation|main nav|top nav|menu bar)$/, 'navigation'],
  [/^(?:header|app bar|top bar|masthead|toolbar)$/, 'banner'],
  [/^(?:footer|site footer|page footer)$/, 'contentinfo'],
  [/^(?:main|main content|content|content area|page content)$/, 'main'],
];

/** The part of a layer name that says what the thing is: "Button/Type=Primary" is a button. */
function head(layerName: string): string {
  return layerName.split('/')[0].split('=')[0];
}

/** The role a layer name implies, or null when the name says nothing about what the thing is. */
export function impliedRole(layerName: string): string | null {
  const name = head(layerName);
  for (const [pattern, role] of ROLE_WORDS) if (pattern.test(name)) return role;
  return null;
}

/** Words designers hang on the end of a section's name, which say nothing about what it is. */
const DECORATION = new Set(['section', 'container', 'wrapper', 'component', 'group', 'frame', 'area', 'block']);

/**
 * The region a section's name implies. "Footer Section" is the footer; "Section Header" is the
 * heading of a section and not the page banner, so only a trailing decoration word is dropped - a
 * leading one changes what the name means. A real design was reported wrongly before this rule.
 */
export function impliedLandmark(layerName: string): string | null {
  const words = head(layerName)
    .replace(/[_#!]/g, ' ')
    .replace(/[^A-Za-z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  while (words.length > 1 && DECORATION.has(words[words.length - 1])) words.pop();
  const phrase = words.join(' ');
  for (const [pattern, role] of LANDMARKS) if (pattern.test(phrase)) return role;
  return null;
}

const PLACEHOLDER = /^(?:lorem ipsum|placeholder|label|text|body|paragraph|xxx+|\.\.\.|…)$/i;

/**
 * Text worth checking for: real words a person would notice missing - **or a number**.
 *
 * This required two consecutive letters, which filters the noise it was written for (a lone glyph,
 * an ellipsis, "Label") and also silently discarded every number in the design. Field-tested: a
 * checkout frame specifying **£54.99** against a page serving **£59.99** produced a byte-identical
 * report - "5 check(s) from the design, 3 met, 2 different" - because the price was never one of the
 * five. A wrong price on a checkout screen is the drift a design review exists to catch, and it was
 * the one kind that could not be seen.
 *
 * A run of two or more digits now counts, so a price, a total, a quantity or a rate becomes a check.
 * A single character still does not, nor does punctuation on its own: `3`, `—` and `...` are noise,
 * `£54.99` and `20%` are the design speaking.
 */
function meaningful(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 120) return false;
  if (!/[A-Za-z]{2}/.test(t) && !/\d{2}/.test(t)) return false;
  return !PLACEHOLDER.test(t);
}

const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The first words inside a node: what a control's accessible name will be on the page. */
function innerText(node: FigmaNode): string {
  for (const { node: child } of walk(node)) {
    if (child.type === 'TEXT' && child.characters && meaningful(child.characters)) return tidy(child.characters);
  }
  return '';
}

/** Every TEXT node id inside a node, so a button's own label is not also checked on its own. */
function textIds(node: FigmaNode): string[] {
  return walk(node).flatMap(({ node: child }) => (child.type === 'TEXT' ? [child.id] : []));
}

const CONTAINER = new Set(['INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'FRAME', 'GROUP', 'SECTION']);

/**
 * A text layer whose name IS a role word - "Button", "Link", "H1" - says what its words are. A name
 * that merely contains one does not: in a real design every paragraph sat in a layer called
 * "Link inline", a text style rather than a link, and whole sentences would have been reported as
 * missing links. Tewip reads the first and ignores the second.
 */
const EXACT_TEXT_ROLES: Record<string, string> = {
  button: 'button', btn: 'button', cta: 'button',
  link: 'link',
  tab: 'tab',
  heading: 'heading', headline: 'heading', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
};

function exactTextRole(layerName: string): string | null {
  const word = head(layerName).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return EXACT_TEXT_ROLES[word] ?? null;
}

/** A link or a button is named by a few words; a sentence is words on the page, not a label. */
function labelLength(role: string, text: string): boolean {
  if (role === 'heading') return true;
  return text.length <= 40 && text.split(/\s+/).length <= 7;
}

/**
 * The checks a frame implies. Controls come first, because a missing button matters more than a
 * missing word, and each check says where in the design it came from.
 */
export function frameChecks(frame: FigmaNode, max = 60): DesignCheck[] {
  const checks: DesignCheck[] = [];
  const consumed = new Set<string>();
  const seen = new Set<string>();
  const add = (check: DesignCheck) => {
    const key = `${check.kind}:${check.role ?? ''}:${check.name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    checks.push(check);
  };

  const nodes = walk(frame);
  for (const { node, path } of nodes) {
    if (!CONTAINER.has(node.type)) continue;
    const where = [...path, node.name].join(' / ');
    const landmark = impliedLandmark(node.name);
    if (landmark) add({ kind: 'landmark', role: landmark, name: '', from: where });
    const role = impliedRole(node.name);
    if (!role) continue;
    const name = innerText(node);
    if (!name) continue; // a control with no words has no accessible name to check
    for (const id of textIds(node)) consumed.add(id);
    add({ kind: 'role', role, name, from: where });
  }

  for (const { node, path } of nodes) {
    if (node.type !== 'TEXT' || !node.characters || consumed.has(node.id)) continue;
    const text = tidy(node.characters);
    if (!meaningful(text)) continue;
    const role = exactTextRole(node.name);
    const from = [...path, node.name].join(' / ');
    if (role && labelLength(role, text)) add({ kind: 'role', role, name: text, from });
    else add({ kind: 'text', name: text, from });
  }
  return checks.slice(0, max);
}
