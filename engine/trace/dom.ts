// Rebuilds DOM snapshots from a trace and condenses them into a short element list.
// Trace snapshots are incremental: a node can be [[n, i]], meaning "node i (post-order)
// of the snapshot n steps back for the same frame". Mirrors Playwright's snapshotRenderer.

type NodeSnapshot = string | [string, Record<string, string>, ...unknown[]] | [[number, number]];

export interface FrameSnapshot {
  frameId: string;
  frameUrl: string;
  isMainFrame?: boolean;
  html: NodeSnapshot;
}

export interface DomNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<DomNode | string>;
}

const isElement = (n: unknown): n is [string, Record<string, string>, ...unknown[]] => Array.isArray(n) && typeof n[0] === 'string';
const isReference = (n: unknown): n is [[number, number]] => Array.isArray(n) && Array.isArray(n[0]);

/** Post-order list of the raw (unresolved) nodes of one snapshot, as the references index them. */
function rawNodes(snapshot: FrameSnapshot, cache: Map<FrameSnapshot, unknown[]>): unknown[] {
  let nodes = cache.get(snapshot);
  if (!nodes) {
    const out: unknown[] = [];
    const visit = (n: unknown) => {
      if (typeof n === 'string') out.push(n);
      else if (isElement(n)) {
        for (const child of n.slice(2)) visit(child);
        out.push(n);
      }
    };
    visit(snapshot.html);
    cache.set(snapshot, (nodes = out));
  }
  return nodes;
}

/** Resolves the last snapshot of the main frame into a plain tree, or null if there is none. */
export function lastMainFrameDom(snapshots: FrameSnapshot[]): { url: string; root: DomNode } | null {
  const main = snapshots.filter((s) => s.isMainFrame !== false);
  if (main.length === 0) return null;
  const frameId = main[main.length - 1].frameId;
  const frame = snapshots.filter((s) => s.frameId === frameId);
  const cache = new Map<FrameSnapshot, unknown[]>();

  const resolve = (n: unknown, index: number, depth: number): DomNode | string | null => {
    if (depth > 200) return null;
    if (typeof n === 'string') return n;
    if (isReference(n)) {
      const refIndex = index - n[0][0];
      const target = frame[refIndex] ? rawNodes(frame[refIndex], cache)[n[0][1]] : undefined;
      return target === undefined ? null : resolve(target, refIndex, depth + 1);
    }
    if (!isElement(n)) return null;
    const [tag, attrs, ...children] = n;
    const resolved = children.map((c) => resolve(c, index, depth + 1)).filter((c): c is DomNode | string => c !== null);
    return { tag: tag.toUpperCase(), attrs: attrs ?? {}, children: resolved };
  };

  const root = resolve(frame[frame.length - 1].html, frame.length - 1, 0);
  return root && typeof root !== 'string' ? { url: frame[frame.length - 1].frameUrl, root } : null;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'HEAD']);
const NOTABLE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'FORM', 'H1', 'H2', 'H3', 'H4', 'DIALOG', 'IMG', 'TABLE']);
const KEPT_ATTRS = ['id', 'data-testid', 'data-test', 'data-qa', 'name', 'type', 'role', 'aria-label', 'placeholder', 'href', 'disabled', 'hidden', 'aria-hidden', 'aria-busy'];

function textOf(node: DomNode | string): string {
  if (typeof node === 'string') return node;
  if (SKIP_TAGS.has(node.tag)) return '';
  return node.children.map(textOf).join(' ');
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function describe(node: DomNode): string {
  const attrs = KEPT_ATTRS.filter((a) => node.attrs[a] !== undefined).map((a) => `${a}="${clip(node.attrs[a], 40)}"`);
  const classes = (node.attrs.class ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  if (classes.length > 0) attrs.push(`class="${classes.join(' ')}"`);
  const text = clip(textOf(node).replace(/\s+/g, ' ').trim(), 60);
  const tag = node.tag.toLowerCase();
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${text}</${tag}>`;
}

/**
 * Elements a selector is likely to target: interactive tags, headings, and anything with an
 * id, test id, role or aria-label. Capped so the model gets a summary, not the page.
 */
export function notableElements(root: DomNode, max = 60): { elements: string[]; omitted: number } {
  const found: string[] = [];
  const visit = (node: DomNode) => {
    if (SKIP_TAGS.has(node.tag)) return;
    const a = node.attrs;
    if (NOTABLE_TAGS.has(node.tag) || a.id || a['data-testid'] || a['data-test'] || a['data-qa'] || a.role || a['aria-label']) {
      if (node.tag !== 'HTML' && node.tag !== 'BODY') found.push(describe(node));
    }
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  visit(root);
  return { elements: found.slice(0, max), omitted: Math.max(0, found.length - max) };
}
