// Phase 145: what an API change breaks for the clients already calling it.
//
// `schema` answers this for a database. An API description is the same question asked of a
// contract: somebody else's code is built against the shape you published, and they will not
// redeploy because you did.
//
// Most of these tests are about the YAML reader rather than the comparison, because that is where
// the work turned out to be. Five fixes went into it against real specs, every one of them a case
// where it refused a file it should have read - and a reader that declines every real input is not
// careful, it is broken. The refusals that remain are the ones that would otherwise invent a
// removed field, which is the only wrong answer this check must never give.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readYaml } from '../contract/yaml-lite.ts';
import { compareOpenApi } from '../contract/openapi.ts';

const NL = String.fromCharCode(10);
const y = (...lines: string[]) => readYaml(lines.join(NL));
const value = (r: ReturnType<typeof readYaml>) => ('value' in r ? r.value : null);
const kinds = (b: ReturnType<typeof compareOpenApi>) => b.map((x) => x.kind).sort();

describe('reading enough YAML to read an API description', () => {
  it('reads nested maps and a list of maps', () => {
    const r = y('paths:', '  /users:', '    get:', '      parameters:', '        - name: id', '          required: true');
    assert.deepEqual(value(r), { paths: { '/users': { get: { parameters: [{ name: 'id', required: true }] } } } });
  });

  it('reads a list at the same indent as its key', () => {
    // Valid YAML, and how the OpenAPI specification's own examples are written. Requiring a
    // deeper indent read the key as empty and then tried to parse `- name:` as a key of the
    // surrounding map.
    const r = y('parameters:', '- name: username', '  in: path');
    assert.deepEqual(value(r), { parameters: [{ name: 'username', in: 'path' }] });
  });

  it('reads a flow collection, which is how enum and required are written', () => {
    assert.deepEqual(value(y('enum: [a, b]', 'required: [id]')), { enum: ['a', 'b'], required: ['id'] });
  });

  it('skips a block scalar instead of refusing the file for it', () => {
    // Nearly always a description, which this comparison never reads. Refusing the file for one
    // turned away 104 of GitHub's 192 descriptions.
    const r = y('info:', '  description: |', '    A long paragraph.', '    paths: not a key', 'openapi: 3.0.0');
    assert.deepEqual(value(r), { info: { description: '' }, openapi: '3.0.0' });
  });

  it('follows a plain scalar that wraps onto the next line', () => {
    const r = y('tags:', '- name: code-quality', '  description: Insights into reliability of your', '    codebase.');
    assert.deepEqual(value(r), { tags: [{ name: 'code-quality', description: 'Insights into reliability of your' }] });
  });

  it('follows a quoted scalar over several lines, colons and all', () => {
    // GitHub's descriptions wrap onto lines beginning "on: creating a trigger", which look
    // exactly like keys. Without tracking the open quote the reader parses prose as structure.
    const r = y("openapi: '3.0.0'", 'info:', "  description: 'The app cannot turn it", "    on: creating one returns 422.'", 'paths:', '  /x:', '    get:', '      responses: {}');
    assert.deepEqual((value(r) as Record<string, unknown>).paths, { '/x': { get: { responses: {} } } });
  });

  it('does not mistake a URL for an anchor', () => {
    // `{&page,per_page}` in a query string refused 185 of GitHub's 192 files. An anchor occupies
    // a value position; this does not.
    const r = y('servers:', '- url: https://api.example.com/search?q={q}{&page,per_page}');
    assert.ok('value' in r, 'a URL is not an anchor');
  });

  it('refuses a real anchor rather than guessing at it', () => {
    // The one refusal worth keeping: an alias changes the shape of the document, and guessing is
    // how a reader invents a removed field.
    const r = y('components:', '  schemas:', '    thing: &1', '      type: object', '    other: *1');
    assert.ok('unreadable' in r && /anchor or an alias/.test(r.unreadable));
  });

  it('refuses rather than half-reading a shape it cannot place', () => {
    const r = y('a: 1', '\tb: 2');
    assert.ok('unreadable' in r && /tab/.test(r.unreadable));
  });
});

describe('what the change breaks', () => {
  const before = [
    'openapi: 3.0.0', 'paths:', '  /users:', '    get:',
    '      parameters:', '        - name: sort', '          required: false', '          schema:', '            enum: [name, age]',
    '      responses:', "        '200':", '          content:', '            application/json:', '              schema:', '                properties:', '                  id:', '                    type: integer', '                  nickname:', '                    type: string',
    "        '404':", '          description: missing',
    '  /legacy:', '    get:', '      responses:', "        '200':", '          description: ok',
  ];

  const compare = (after: string[]) => {
    const a = readYaml(before.join(NL));
    const b = readYaml(after.join(NL));
    assert.ok('value' in a && 'value' in b, 'both versions read');
    return compareOpenApi(a.value, b.value);
  };

  it('finds nothing when nothing changed', () => {
    assert.deepEqual(compare(before), []);
  });

  it('names an endpoint that is gone, and tells it from a method that is gone', () => {
    const gone = compare(before.filter((l) => !['  /legacy:', '    get:', '      responses:', "        '200':", '          description: ok'].includes(l) || before.indexOf(l) < 20));
    assert.ok(gone.some((b) => b.kind === 'endpoint-removed'));
  });

  it('names a parameter that became required, and one that arrived required', () => {
    const now = compare(before.map((l) => (l === '          required: false' ? '          required: true' : l)));
    assert.deepEqual(kinds(now), ['parameter-now-required']);
    assert.match(now[0].what, /was optional/);
  });

  it('names an enum value a caller can no longer send', () => {
    const now = compare(before.map((l) => (l === '            enum: [name, age]' ? '            enum: [name]' : l)));
    assert.deepEqual(kinds(now), ['enum-value-removed']);
    assert.match(now[0].what, /`age`/);
  });

  it('names a response field that is gone and one whose type changed', () => {
    const now = compare(
      before.filter((l) => !['                  nickname:', '                    type: string'].includes(l)).map((l) => (l === '                    type: integer' ? '                    type: string' : l)),
    );
    assert.deepEqual(kinds(now), ['property-removed', 'property-type-changed']);
  });

  it('says nothing about a field that was added', () => {
    const added = [...before];
    added.splice(added.indexOf('                  nickname:'), 0, '                  email:', '                    type: string');
    assert.deepEqual(compare(added), [], 'a new field breaks nobody');
  });

  it('does not call an unstated type a change of type', () => {
    const vague = before.map((l) => (l === '                    type: integer' ? '                    description: the id' : l));
    assert.deepEqual(kinds(compare(vague)).filter((k) => k === 'property-type-changed'), []);
  });
});
