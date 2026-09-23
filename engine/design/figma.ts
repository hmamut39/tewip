// Phase 11: the design is a specification nobody tests against.
//
// This reads a Figma file through Figma's own REST API and hands back the node tree. It only ever
// reads: no comments posted, no nodes changed, nothing exported. A design token is a read token as
// far as Tewip is concerned.
//
// Settings: TEWIP_FIGMA_TOKEN (a personal access token from Figma > Settings > Security).
// A saved node JSON file works too, so the checks can be looked at without a token at all.

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  /** The words of a TEXT node. */
  characters?: string;
  children?: FigmaNode[];
  visible?: boolean;
  /** Set on an INSTANCE: the component it came from, whose name says what it is. */
  componentId?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
}

export interface FigmaTarget {
  /** The file key from the link. */
  key: string;
  /** The frame, when the link points at one. Figma's own links use "12-34"; the API wants "12:34". */
  nodeId?: string;
}

/** The file key and frame from any Figma link: /file/, /design/ or /proto/. */
export function parseFigmaUrl(url: string): FigmaTarget | null {
  const match = /figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]{10,})/.exec(url);
  if (!match) return null;
  const node = /[?&]node-id=([^&#]+)/.exec(url);
  const raw = node ? decodeURIComponent(node[1]) : '';
  return { key: match[1], nodeId: raw ? raw.replace(/-/g, ':') : undefined };
}

export function figmaTokenFromEnv(): string | null {
  return process.env.TEWIP_FIGMA_TOKEN?.trim() || null;
}

export function figmaHelp(): string {
  return [
    'Figma is not set up. One setting, from your own account:',
    '  TEWIP_FIGMA_TOKEN=figd_...   (Figma > Settings > Security > Personal access tokens,',
    '                                file content: read-only is enough)',
    'Or save a frame as JSON and pass the file instead of the link.',
  ].join('\n');
}

export class Figma {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`https://api.figma.com${path}`, { headers: { 'X-Figma-Token': this.token } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (res.status === 403) throw new Error(`Figma refused the token (403). It needs file content read access to this file: ${body}`);
      if (res.status === 404) throw new Error(`Figma has no such file or frame (404). Check the link is one you can open: ${body}`);
      throw new Error(`Figma GET ${path} -> ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  /** The frame a link points at, or the whole document when it points at no frame. */
  async frame(target: FigmaTarget, depth = 12): Promise<{ node: FigmaNode; fileName: string }> {
    if (target.nodeId) {
      const body = await this.get<{ name: string; nodes: Record<string, { document?: FigmaNode } | null> }>(
        `/v1/files/${target.key}/nodes?ids=${encodeURIComponent(target.nodeId)}&depth=${depth}`,
      );
      const found = body.nodes[target.nodeId] ?? Object.values(body.nodes)[0];
      if (!found?.document) throw new Error(`Figma returned no frame for node ${target.nodeId}. The link may point at a page rather than a frame.`);
      return { node: found.document, fileName: body.name ?? target.key };
    }
    const body = await this.get<{ name: string; document: FigmaNode }>(`/v1/files/${target.key}?depth=${depth}`);
    return { node: body.document, fileName: body.name ?? target.key };
  }
}

/**
 * The frames on a page, when a link pointed at a whole file rather than one frame. A SECTION is a
 * board of frames in newer Figma files, so it is opened rather than treated as a screen - unless it
 * holds the content itself, which real files do too.
 */
export function topFrames(node: FigmaNode): FigmaNode[] {
  if (node.type === 'FRAME' || node.type === 'COMPONENT') return [node];
  const found: FigmaNode[] = [];
  for (const child of node.children ?? []) found.push(...topFrames(child));
  if (found.length === 0 && node.type === 'SECTION' && (node.children ?? []).length > 0) return [node];
  return found;
}

/** Every node in a tree, parents before children, skipping anything hidden in the design. */
export function walk(node: FigmaNode, path: string[] = []): Array<{ node: FigmaNode; path: string[] }> {
  if (node.visible === false) return [];
  const here = [...path, node.name];
  const out: Array<{ node: FigmaNode; path: string[] }> = [{ node, path }];
  for (const child of node.children ?? []) out.push(...walk(child, here));
  return out;
}
