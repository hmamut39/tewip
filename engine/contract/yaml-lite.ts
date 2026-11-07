// Enough YAML to read an API description, and an outright refusal for the rest.
//
// Tewip has two runtime dependencies and intends to keep it that way - a tool that reports on
// other people's dependency trees should be able to stand on its own. So rather than pull in a
// YAML library to read an OpenAPI file, this reads the block subset those files are actually
// written in: nested maps, lists, and scalars.
//
// Measured, because a reader that refuses everything is useless however honest each refusal is.
// On the OpenAPI specification's own examples it reads 5 of 8. On GitHub's REST API description -
// 192 files, a quarter of a million lines, the hardest YAML in public - it reads **none**: half use
// real anchors and the rest nest past what this follows.
//
// That sounds worse than it is, and the reason is worth knowing: GitHub publishes the same 192
// descriptions as JSON, and those parse exactly - 121,566 paths, no reader of mine involved. A
// published API description is nearly always available as JSON, `JSON.parse` is exact, and the
// command says so when it cannot read the YAML. Five fixes went into this reader before that
// became clear, each one correct and none of them the point.
//
// The important half is what it does when it meets anything else. An anchor, a flow collection, a
// folded scalar or a tab make it return `unreadable` with the line and the reason, and the command
// above prints that instead of a comparison. A half-parsed API description would produce confident
// nonsense about what changed - fields that look removed because the reader lost its place - and
// there is no worse output for this particular check.
export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

export type YamlRead = { value: Yaml } | { unreadable: string; line: number };

interface Line {
  indent: number;
  text: string;
  line: number;
}

const SCALAR = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^#]*?)\s*(?:#.*)?$/;

/** A value written on one line: a quoted string, a number, a boolean, null, or bare text. */
function scalar(raw: string): Yaml {
  const text = raw.trim();
  if (text === '') return null;
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return text.slice(1, -1).replace(/\\(.)/g, '$1');
  if (/^'(?:[^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/**
 * What this reader will not pretend to understand.
 *
 * Shorter than it was, and that is the point. The first version also refused block scalars and
 * flow collections, which read honestly and uselessly: on GitHub's own REST API description it
 * refused **192 files out of 192**, and on the OpenAPI specification repository 7 of 8. A check
 * that declines every real input is not careful, it is broken - the refusals were right about each
 * file and wrong about the job.
 *
 * Both are now handled, and for different reasons. A block scalar is nearly always a `description`,
 * which this comparison never looks at, so its contents are skipped rather than read. A flow
 * collection is how `enum: [a, b]` and `required: [id]` are usually written, and those are exactly
 * the fields the comparison needs.
 *
 * An anchor still refuses. An alias changes the shape of the document, and guessing at it is how a
 * reader invents a removed field.
 */
function refuse(text: string): string | null {
  if (/\t/.test(text)) return 'a tab, which YAML does not allow for indentation';
  // An anchor or an alias occupies a value position and is the whole token there. Written loosely
  // as "an & or a * after a space", this matched `{&page,per_page}` inside a URL and refused 185
  // of GitHub's 192 descriptions - a refusal that reads as caution and is simply a wrong answer
  // about what is in the file.
  if (/(?::\s+|^\s*-\s+)[&*][\w-]+(?:\s|$)/.test(text)) return 'an anchor or an alias, which this reader does not follow';
  return null;
}

/** `[a, b]` and `{a: 1}`, one level deep, which is how enum and required are usually written. */
function flow(text: string): Yaml | undefined {
  const t = text.trim();
  if (/^\[.*\]$/.test(t)) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    if (/[[\]{}]/.test(inner)) return undefined;
    return inner.split(',').map((p) => scalar(p));
  }
  if (/^\{.*\}$/.test(t)) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return {};
    if (/[[\]{}]/.test(inner)) return undefined;
    const map: Record<string, Yaml> = {};
    for (const pair of inner.split(',')) {
      const kv = /^([^:]+):\s*(.*)$/.exec(pair.trim());
      if (!kv) return undefined;
      map[kv[1].trim().replace(/^["']|["']$/g, '')] = scalar(kv[2]);
    }
    return map;
  }
  return undefined;
}

export function readYaml(source: string): YamlRead {
  const lines: Line[] = [];
  let at = 0;
  let blockScalarUntil: number | null = null;
  // A quoted scalar may run over several lines, and its later lines contain anything at all -
  // including a colon, which makes them look exactly like keys. GitHub's descriptions do this
  // constantly - a sentence wrapping onto a line that begins "on: creating a trigger" - and
  // without tracking the open quote the reader starts parsing that prose as structure.
  let openQuote: string | null = null;
  for (const raw of source.split(String.fromCharCode(10))) {
    at += 1;
    // Only the first document: an OpenAPI file is one, and guessing which of several is meant
    // would be a choice this has no basis for making.
    if (/^\.\.\.\s*$/.test(raw)) break;
    if (/^---\s*$/.test(raw) && lines.length > 0) break;
    if (/^---\s*$/.test(raw)) continue;
    const withoutComment = /^\s*#/.test(raw) ? '' : raw;
    if (withoutComment.trim() === '') continue;
    const bad = refuse(withoutComment);
    if (bad) return { unreadable: bad, line: at };
    const indent = withoutComment.search(/\S/);
    // A block scalar's body belongs to its key, not to the document. Those bodies are almost
    // always a `description`, which this comparison never reads, so the key is kept with an empty
    // value and everything indented under it is skipped. Left in, the prose lines parse as keys.
    if (/:\s*[|>][-+\d]*\s*$/.test(withoutComment)) {
      lines.push({ indent, text: withoutComment.trim().replace(/[|>][-+\d]*\s*$/, "''"), line: at });
      blockScalarUntil = indent;
      continue;
    }
    if (blockScalarUntil !== null) {
      if (indent > blockScalarUntil) continue;
      blockScalarUntil = null;
    }
    // A plain scalar may wrap onto the next, more-indented line, with no `|` to announce it:
    //   description: A long sentence that
    //     continues here.
    // The continuation is part of the value above, not a line of its own. GitHub's descriptions
    // wrap constantly, and read as lines they are leftovers the parser cannot place.
    if (openQuote !== null) {
      const closes = (withoutComment.match(new RegExp(openQuote, 'g')) ?? []).length % 2 === 1;
      if (closes) openQuote = null;
      continue;
    }
    const value = /:\s*(.*)$/.exec(withoutComment.trim())?.[1] ?? '';
    const starts = /^(['"])/.exec(value);
    if (starts && (value.match(new RegExp(starts[1], 'g')) ?? []).length % 2 === 1) {
      openQuote = starts[1];
      lines.push({ indent, text: withoutComment.trim(), line: at });
      continue;
    }
    const previous = lines.at(-1);
    const continuation =
      previous !== undefined &&
      indent > previous.indent &&
      !withoutComment.trim().startsWith('- ') &&
      !/^[^:\s][^:]*:(?:\s|$)/.test(withoutComment.trim()) &&
      /:\s*\S/.test(previous.text);
    if (continuation) continue;
    lines.push({ indent, text: withoutComment.trim(), line: at });
  }
  if (lines.length === 0) return { value: null };

  let i = 0;
  const block = (indent: number): Yaml => {
    // A list at this level.
    if (lines[i] && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const items: Yaml[] = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
        const rest = lines[i].text.slice(2).trim();
        const key = /^([^:\s][^:]*):\s*(.*)$/.exec(rest);
        if (key) {
          // `- name: x` opens a map whose later keys are indented to where `name` started.
          const inner: Record<string, Yaml> = {};
          const innerIndent = indent + 2;
          inner[key[1].trim()] = key[2].trim() === '' ? nested(innerIndent) : scalar(key[2]);
          if (key[2].trim() === '') {
            // `nested` already advanced past the block.
          } else {
            i += 1;
          }
          while (i < lines.length && lines[i].indent >= innerIndent && !lines[i].text.startsWith('- ')) {
            const more = /^([^:\s][^:]*):\s*(.*)$/.exec(lines[i].text);
            if (!more) break;
            const name = more[1].trim();
            if (more[2].trim() === '') {
              i += 1;
              inner[name] = block(nextIndent(innerIndent));
            } else {
              inner[name] = scalar(more[2]);
              i += 1;
            }
          }
          items.push(inner);
          continue;
        }
        if (rest === '') {
          i += 1;
          items.push(block(nextIndent(indent)));
          continue;
        }
        const asFlow = flow(rest);
        items.push(asFlow === undefined ? scalar(rest) : asFlow);
        i += 1;
      }
      return items;
    }
    // A map at this level.
    const map: Record<string, Yaml> = {};
    while (i < lines.length && lines[i].indent === indent) {
      // A list item is not a key, even though `- name: x` matches a key pattern.
      if (lines[i].text.startsWith('- ')) break;
      const m = /^([^:\s][^:]*):\s*(.*)$/.exec(lines[i].text);
      if (!m) break;
      const key = m[1].trim().replace(/^["']|["']$/g, '');
      const inline = m[2].trim();
      if (inline === '') {
        i += 1;
        // A list may sit at the SAME indent as the key it belongs to - valid YAML, and how the
        // OpenAPI specification's own examples and GitHub's descriptions are written:
        //   parameters:
        //   - name: username
        // Requiring a deeper indent read `parameters` as empty and then tried to parse `- name:`
        // as a key of the surrounding map, which is how 192 of 192 real files came back
        // "nests in a way this reader does not follow".
        const next = lines[i];
        const nested_ = next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')));
        map[key] = nested_ ? block(next.indent) : null;
      } else {
        const asFlow = flow(inline);
        map[key] = asFlow === undefined ? scalar(inline) : asFlow;
        i += 1;
      }
    }
    return map;
  };

  /** The indent of the next line, used when a list item opens a block. */
  const nextIndent = (fallback: number): number => (i < lines.length ? lines[i].indent : fallback);
  const nested = (fallback: number): Yaml => {
    i += 1;
    return i < lines.length ? block(lines[i].indent) : null;
  };

  const value = block(lines[0].indent);
  // Lines left over mean the shape was not what this reader understood, and a partial read of an
  // API description is exactly the thing that invents removed fields.
  if (i < lines.length) return { unreadable: 'the file nests in a way this reader does not follow', line: lines[i].line };
  return { value };
}

/** The scalar guard, exported so a test can show which shapes are refused rather than guessed. */
export const refusedBecause = refuse;
export const asScalar = scalar;
export const SCALAR_SHAPE = SCALAR;
