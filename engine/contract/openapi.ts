// What an API change breaks for the clients already calling it.
//
// `schema` answers this for a database: what does this migration do to the version still running.
// An API description is the same question asked of a contract - somebody else's code is built
// against the shape you published, and they will not redeploy because you did.
//
// The comparison is between two versions of one file, which is what makes it decidable: a field
// that is gone is gone, and no judgement is involved. What this cannot see is whether anybody was
// using it, so a removal is reported as a removal and the report says plainly that who depended on
// it is not a question a file can answer.
import type { Yaml } from './yaml-lite.ts';

export interface Break {
  kind: BreakKind;
  /** Where in the API, in the words the description uses. */
  where: string;
  what: string;
  /** What a client doing this today sees after the change. */
  breaks: string;
}

export type BreakKind =
  | 'endpoint-removed'
  | 'method-removed'
  | 'parameter-now-required'
  | 'response-removed'
  | 'property-removed'
  | 'property-type-changed'
  | 'enum-value-removed';

export const BREAKS_WHO: Record<BreakKind, string> = {
  'endpoint-removed': 'every client calling it gets a 404 at the moment you deploy',
  'method-removed': 'a client using that verb gets a 405, including one that only ever used it occasionally',
  'parameter-now-required': 'every existing caller is now sending an incomplete request',
  'response-removed': 'a client handling that status has a branch that will never be taken again, and one that will',
  'property-removed': 'a client reading that field gets undefined, usually far from here and usually at run time',
  'property-type-changed': 'a client parsing that field gets the wrong type, which fails somewhere else entirely',
  'enum-value-removed': 'a client that still sends the old value is rejected',
};

const isMap = (v: Yaml): v is Record<string, Yaml> => typeof v === 'object' && v !== null && !Array.isArray(v);
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/**
 * A local `$ref` followed to the thing it names.
 *
 * Only within the same document, and only one hop at a time. A ref to another file is left alone
 * and the schema is treated as unknown, which means its fields are not compared rather than
 * reported as removed - the safe direction, and the one that matters: a reader who is told a field
 * vanished because the reader could not follow a pointer stops trusting the whole report.
 */
function follow(doc: Yaml, node: Yaml, depth = 0): Yaml {
  if (!isMap(node) || depth > 8) return node;
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let at: Yaml = doc;
  for (const part of ref.slice(2).split('/')) {
    if (!isMap(at)) return {};
    at = at[part.replace(/~1/g, '/').replace(/~0/g, '~')] ?? {};
  }
  return follow(doc, at, depth + 1);
}

/** Every property of a schema, flattened to `a.b.c`, with its type and its enum if it has one. */
function propertiesOf(doc: Yaml, schema: Yaml, prefix = '', depth = 0): Map<string, { type: string; values?: string[] }> {
  const out = new Map<string, { type: string; values?: string[] }>();
  const node = follow(doc, schema);
  if (!isMap(node) || depth > 6) return out;
  // allOf is how an API description spells inheritance; its parts are all part of the shape.
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    for (const [k, v] of propertiesOf(doc, part, prefix, depth + 1)) out.set(k, v);
  }
  const items = node.items;
  if (items !== undefined) for (const [k, v] of propertiesOf(doc, items, prefix, depth + 1)) out.set(k, v);
  const properties = node.properties;
  if (!isMap(properties)) return out;
  for (const [name, raw] of Object.entries(properties)) {
    const value = follow(doc, raw);
    const path = prefix ? `${prefix}.${name}` : name;
    const type = isMap(value) && typeof value.type === 'string' ? value.type : 'unstated';
    const values = isMap(value) && Array.isArray(value.enum) ? value.enum.map((e) => String(e)).sort() : undefined;
    out.set(path, { type, values });
    for (const [k, v] of propertiesOf(doc, value, path, depth + 1)) out.set(k, v);
  }
  return out;
}

interface Operation {
  /** Parameter name to whether it is required. */
  parameters: Map<string, boolean>;
  /** Enum values a request parameter accepts. */
  parameterValues: Map<string, string[]>;
  responses: Set<string>;
  /** Response status to the properties it returns. */
  responseShape: Map<string, Map<string, { type: string; values?: string[] }>>;
}

function operationOf(doc: Yaml, node: Yaml): Operation {
  const op: Operation = { parameters: new Map(), parameterValues: new Map(), responses: new Set(), responseShape: new Map() };
  if (!isMap(node)) return op;
  for (const raw of Array.isArray(node.parameters) ? node.parameters : []) {
    const p = follow(doc, raw);
    if (!isMap(p) || typeof p.name !== 'string') continue;
    op.parameters.set(p.name, p.required === true);
    const schema = follow(doc, p.schema ?? {});
    if (isMap(schema) && Array.isArray(schema.enum)) op.parameterValues.set(p.name, schema.enum.map((e) => String(e)).sort());
  }
  const responses = node.responses;
  if (isMap(responses)) {
    for (const [status, raw] of Object.entries(responses)) {
      op.responses.add(status);
      const response = follow(doc, raw);
      if (!isMap(response) || !isMap(response.content)) continue;
      for (const media of Object.values(response.content)) {
        if (!isMap(media)) continue;
        const shape = propertiesOf(doc, media.schema ?? {});
        if (shape.size > 0) op.responseShape.set(status, shape);
      }
    }
  }
  return op;
}

/** Every operation in a document, keyed `GET /users/{id}`. */
function operations(doc: Yaml): Map<string, Operation> {
  const out = new Map<string, Operation>();
  if (!isMap(doc) || !isMap(doc.paths)) return out;
  for (const [path, raw] of Object.entries(doc.paths)) {
    const item = follow(doc, raw);
    if (!isMap(item)) continue;
    for (const method of METHODS) {
      if (item[method] === undefined) continue;
      out.set(`${method.toUpperCase()} ${path}`, operationOf(doc, item[method]));
    }
  }
  return out;
}

export function compareOpenApi(before: Yaml, after: Yaml): Break[] {
  const old = operations(before);
  const now = operations(after);
  const breaks: Break[] = [];
  const paths = (m: Map<string, Operation>) => new Set([...m.keys()].map((k) => k.slice(k.indexOf(' ') + 1)));
  const newPaths = paths(now);

  for (const [key, was] of old) {
    const is = now.get(key);
    if (!is) {
      const path = key.slice(key.indexOf(' ') + 1);
      const kind: BreakKind = newPaths.has(path) ? 'method-removed' : 'endpoint-removed';
      breaks.push({ kind, where: key, what: newPaths.has(path) ? 'this method is gone; the path is still there' : 'this endpoint is gone', breaks: BREAKS_WHO[kind] });
      continue;
    }
    for (const [name, wasRequired] of was.parameters) {
      const isRequired = is.parameters.get(name);
      if (isRequired === true && wasRequired === false) {
        breaks.push({ kind: 'parameter-now-required', where: `${key} · ${name}`, what: 'was optional, is now required', breaks: BREAKS_WHO['parameter-now-required'] });
      }
    }
    for (const [name, isRequired] of is.parameters) {
      if (isRequired && !was.parameters.has(name)) {
        breaks.push({ kind: 'parameter-now-required', where: `${key} · ${name}`, what: 'is new and required', breaks: BREAKS_WHO['parameter-now-required'] });
      }
    }
    for (const [name, wasValues] of was.parameterValues) {
      const isValues = is.parameterValues.get(name);
      if (!isValues) continue;
      const gone = wasValues.filter((v) => !isValues.includes(v));
      if (gone.length > 0) {
        breaks.push({ kind: 'enum-value-removed', where: `${key} · ${name}`, what: `no longer accepts ${gone.map((g) => `\`${g}\``).join(', ')}`, breaks: BREAKS_WHO['enum-value-removed'] });
      }
    }
    for (const status of was.responses) {
      if (!is.responses.has(status)) {
        breaks.push({ kind: 'response-removed', where: `${key} · ${status}`, what: 'this response is no longer described', breaks: BREAKS_WHO['response-removed'] });
      }
    }
    for (const [status, wasShape] of was.responseShape) {
      const isShape = is.responseShape.get(status);
      if (!isShape || isShape.size === 0) continue;
      for (const [field, wasProp] of wasShape) {
        const isProp = isShape.get(field);
        if (!isProp) {
          breaks.push({ kind: 'property-removed', where: `${key} · ${status} · ${field}`, what: 'this field is gone from the response', breaks: BREAKS_WHO['property-removed'] });
          continue;
        }
        // `unstated` on either side is not a change of type, it is a description that never said.
        if (wasProp.type !== isProp.type && wasProp.type !== 'unstated' && isProp.type !== 'unstated') {
          breaks.push({ kind: 'property-type-changed', where: `${key} · ${status} · ${field}`, what: `was ${wasProp.type}, is now ${isProp.type}`, breaks: BREAKS_WHO['property-type-changed'] });
        }
      }
    }
  }
  return breaks;
}

/** What comparing two descriptions cannot settle. */
export const OPENAPI_NOT_CHECKED = [
  'whether anybody was actually using what was removed: a description does not know its callers',
  'a `$ref` into another file, whose shape is treated as unknown rather than as empty',
  'behaviour that is not in the description - what the endpoint does, not what it declares',
  'a change that is breaking only in context, such as a field that keeps its type and changes meaning',
];
