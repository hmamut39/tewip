// Phase 5, for the tools that do not have a page snapshot: Cypress, Selenium and WebdriverIO.
//
// Playwright's traces tell Tewip what was on the page, so a drifted locator can be matched against
// the real elements. A Cypress or Selenium failure in a JUnit report carries none of that - only
// "Expected to find element: '#submit-btn', but never found it". Inventing a replacement from that
// would be exactly the kind of guess this project exists not to make.
//
// So the answer comes from the repository instead. If a test looks for `#submit-btn` and the app
// now renders `id="submit-button"`, the new name is in the application source, and git knows which
// commit renamed it. That is evidence, not a guess - and the fix is still only kept if the test
// passes afterwards.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface SelectorToken {
  /** 'id', 'class', 'data' or 'text': what kind of thing the selector was looking for. */
  kind: 'id' | 'class' | 'data' | 'text';
  /** The attribute, for a data selector: data-cy, data-testid... */
  attribute?: string;
  /** The value the test looked for. */
  value: string;
}

/** What a CSS or XPath selector is really identifying, when it is something identifiable. */
export function tokenOf(selector: string): SelectorToken | null {
  // Selenium and WebdriverIO name the strategy first: "css selector=#submit-btn", "id=submit-btn".
  const strategy = /^(css selector|css|xpath|id|name|class name|link text|partial link text|tag name)\s*=\s*(.+)$/i.exec(selector.trim());
  const s = (strategy ? strategy[2] : selector).trim();
  if (strategy) {
    const method = strategy[1].toLowerCase();
    if (method === 'id') return { kind: 'id', value: s };
    if (method === 'class name') return { kind: 'class', value: s.split(/\s+/)[0] };
    if (method === 'link text' || method === 'partial link text') return { kind: 'text', value: s };
  }
  const data = /\[\s*([\w-]*data[\w-]*)\s*[~|^$*]?=\s*["']?([^"'\]]+)["']?\s*\]/i.exec(s);
  if (data) return { kind: 'data', attribute: data[1], value: data[2] };
  const id = /^#([\w-]+)$|\[\s*id\s*=\s*["']([^"']+)["']\s*\]|@id\s*=\s*["']([^"']+)["']/i.exec(s);
  if (id) return { kind: 'id', value: id[1] ?? id[2] ?? id[3] };
  const cls = /^\.([\w-]+)$|\[\s*class\s*=\s*["']([^"']+)["']\s*\]/i.exec(s);
  if (cls) return { kind: 'class', value: (cls[1] ?? cls[2]).split(/\s+/)[0] };
  const text = /text\(\)\s*=\s*["']([^"']+)["']|contains\(\s*(?:text\(\)|\.)\s*,\s*["']([^"']+)["']/i.exec(s);
  if (text) return { kind: 'text', value: text[1] ?? text[2] };
  return null;
}

/** How close two names are, 0 to 1, by the words in them - "submit-btn" and "submit-button". */
export function closeness(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared++;
  // A shared prefix counts too: "submitBtn" and "submitButton" have no word in common.
  const prefix = commonPrefix(a.toLowerCase(), b.toLowerCase()) / Math.max(a.length, b.length);
  return Math.max(shared / Math.max(left.size, right.size), prefix);
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export interface Renamed {
  /** What the application source has now. */
  value: string;
  /** Where it was found, for the report. */
  file: string;
  /** How it was found: from the commit that renamed it, or from the current source. */
  how: 'renamed in git' | 'found in the source';
  /** The commit that renamed it, when git could say. */
  commit?: string;
  score: number;
}

const git = (root: string, args: string[]): string => {
  try {
    // Captured, not inherited: see the note in grounding.ts.
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
};

/**
 * The commit that removed this value, and what took its place on the same line. This is the
 * strongest evidence there is: somebody renamed it, and the diff says to what.
 */
export function renamedInGit(root: string, token: SelectorToken, maxCommits = 5): Renamed | null {
  const shas = git(root, ['log', '-S', token.value, '--format=%H', `-n${maxCommits}`, '--', '.'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sha of shas) {
    const diff = git(root, ['show', '--unified=0', '--format=', sha]);
    if (!diff) continue;
    let file = '';
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) file = line.slice(6);
      else if (line.startsWith('-') && line.includes(token.value)) removed.push(line);
      else if (line.startsWith('+')) added.push(line);
    }
    if (removed.length === 0 || added.length === 0) continue;
    // The best replacement is the attribute value on an added line that most resembles the old one.
    let best: Renamed | null = null;
    for (const line of added) {
      for (const value of attributeValues(line, token)) {
        const score = closeness(token.value, value);
        if (value !== token.value && score >= 0.5 && (!best || score > best.score)) {
          best = { value, file, how: 'renamed in git', commit: sha.slice(0, 8), score };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Values of the same kind of attribute written on a line of source. */
function attributeValues(line: string, token: SelectorToken): string[] {
  const out: string[] = [];
  const attribute = token.kind === 'data' ? token.attribute ?? 'data-[\\w-]+' : token.kind === 'id' ? 'id' : token.kind === 'class' ? 'class(?:Name)?' : '';
  if (!attribute) return out;
  const pattern = new RegExp(`${attribute}\\s*=\\s*["'\`{]?\\s*["']?([\\w\\s-]+)["']?`, 'gi');
  for (const m of line.matchAll(pattern)) {
    for (const value of m[1].trim().split(/\s+/)) if (value) out.push(value);
  }
  return out;
}

/**
 * The closest value of the same kind anywhere in the application source now. Weaker than git,
 * because nobody wrote down that it is a rename - so it is offered only when it is clearly close.
 */
export function likeItInSource(root: string, token: SelectorToken, sources: string[], min = 0.6): Renamed | null {
  let best: Renamed | null = null;
  for (const file of sources) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes(token.value)) return null; // it is still there; this is not a rename
    for (const line of text.split('\n')) {
      for (const value of attributeValues(line, token)) {
        const score = closeness(token.value, value);
        if (value !== token.value && score >= min && (!best || score > best.score)) {
          best = { value, file, how: 'found in the source', score };
        }
      }
    }
  }
  return best;
}

/** The selector written the way each tool writes it, so the fix reads like the rest of the test. */
export function writeSelector(token: SelectorToken, value: string): string {
  if (token.kind === 'id') return `#${value}`;
  if (token.kind === 'class') return `.${value}`;
  if (token.kind === 'data') return `[${token.attribute}="${value}"]`;
  return value;
}
