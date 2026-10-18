// A small XML reader, enough for JUnit reports: elements, attributes, text, CDATA, comments and
// entities. Test reports are machine-written and well-formed, so this avoids a dependency; it is
// not a general-purpose parser (no DTDs, no namespaces beyond keeping prefixed names as written).

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text and CDATA directly inside this element. */
  text: string;
  /**
   * Set on the root when the document ended with elements still open: it was cut off while being
   * written or uploaded. The parser has always known this - the tag stack is simply left standing -
   * and threw it away, so a report holding half a run parsed without complaint.
   */
  truncated?: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parses a document and returns its root element; throws on input that is not XML. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      i = end(source, '-->', lt) + 3;
    } else if (source.startsWith('<![CDATA[', lt)) {
      const close = end(source, ']]>', lt);
      top.text += source.slice(lt + 9, close);
      i = close + 3;
    } else if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      i = end(source, '>', lt) + 1;
    } else if (source.startsWith('</', lt)) {
      const close = end(source, '>', lt);
      const name = source.slice(lt + 2, close).trim();
      // Tolerate a stray closing tag rather than corrupting the tree.
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      i = close + 1;
    } else {
      const close = tagEnd(source, lt);
      const raw = source.slice(lt + 1, close);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const name = body.match(/^[^\s/>]+/)?.[0] ?? '';
      const attrs: Record<string, string> = {};
      for (const [, key, dq, sq] of body.slice(name.length).matchAll(ATTRIBUTE)) attrs[key] = decodeEntities(dq ?? sq ?? '');
      const element: XmlElement = { name, attrs, children: [], text: '' };
      top.children.push(element);
      if (!selfClosing) stack.push(element);
      i = close + 1;
    }
  }
  const first = root.children[0];
  if (!first) throw new Error('not an XML document: no root element');
  // Anything still on the stack is an element nobody closed. Well-formed XML leaves only the
  // document itself behind.
  if (stack.length > 1) first.truncated = true;
  return first;
}

function end(source: string, token: string, from: number): number {
  const at = source.indexOf(token, from);
  if (at < 0) throw new Error(`unterminated XML near offset ${from}`);
  return at;
}

/** The end of a start tag, skipping '>' characters inside quoted attribute values. */
function tagEnd(source: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  throw new Error(`unterminated tag near offset ${from}`);
}

/** Every descendant element with this name, depth first. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(element);
  return out;
}
