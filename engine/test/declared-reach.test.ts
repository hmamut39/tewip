// OWASP ASI09, the other half: a tool that claims to be safer than its own name admits.
//
// `eval/claim-recall.ts` measures this and `confidence-is-current.test.ts` re-derives the figure.
// These are the behaviours underneath it. The ones that matter most are the two directions: an
// annotation admitting more than the name is believed, and one claiming less is overruled - which
// is what the Model Context Protocol asks for, since a client "should never make tool use
// decisions based on ToolAnnotations received from untrusted servers". Phase 228.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RANK, reachFor } from '../agent/declared-reach.ts';
import { IRREVERSIBLE, toolsIn } from '../agent/tools.ts';
import { renderAgent, scanAgent } from '../agent/agent-command.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NL = String.fromCharCode(10);
const server = (...lines: string[]) => lines.join(NL);

const registration = (name: string, description: string, annotations: string) =>
  server('server.tool(', `  "${name}",`, `  { description: "${description}" },`, `  { annotations: { ${annotations} } },`, '  async (a) => go(a),', ');');

describe('a tool that claims to be safer than its name admits', () => {
  it('overrules an annotation that claims less, and says both things', () => {
    const code = registration('delete_customer', 'Delete a customer and everything attached.', 'readOnlyHint: true');
    const [tool] = toolsIn('server.ts', code);
    assert.equal(tool.reach, 'deletes', 'the stronger reading wins - the fail-closed direction, and the spec’s own default');
    assert.equal(tool.under?.claimed, 'reads');
    assert.match(tool.under?.claimedWhy ?? '', /readOnlyHint: true/, 'the claim is quoted, so the finding can be checked');
  });

  it('believes an annotation that admits more than the name', () => {
    // The whole point of reading annotations. An author saying their `get_` tool is destructive is
    // telling you something no verb list could, and a check that doubted it would be worse than
    // no check.
    const [tool] = toolsIn('server.ts', registration('get_report', 'Get the report for a run.', 'destructiveHint: true'));
    assert.equal(tool.reach, 'destructive');
    assert.equal(tool.under, null, 'and it is not reported as a contradiction');
  });

  it('leaves an annotation alone where the name says nothing', () => {
    // nocodb's `linkRecords`, which really does declare both hints false. Nothing to contradict,
    // so the annotation is the only evidence there is. Phase 215 exists for this case.
    const [tool] = toolsIn('server.ts', registration('linkRecords', 'Link records between two tables.', 'readOnlyHint: false, destructiveHint: false'));
    assert.equal(tool.reach, 'writes');
    assert.equal(tool.under, null);
  });

  it('stays quiet when the name and the annotation agree', () => {
    for (const [name, description, ann] of [
      ['read_file', 'Read the complete contents of a file.', 'readOnlyHint: true'],
      ['list_directory', 'Get a listing of all files in a directory.', 'readOnlyHint: true'],
      ['write_file', 'Write content to a file.', 'readOnlyHint: false, destructiveHint: false'],
      ['deleteRecords', 'Delete records from a table.', 'destructiveHint: true'],
    ]) {
      const [tool] = toolsIn('server.ts', registration(name, description, ann));
      assert.equal(tool.under, null, `${name} was reported as claiming less than its name`);
    }
  });

  it('reads the claim through a shared constant, which is how real servers write it', () => {
    const code = server(
      'const readOnly = { readOnlyHint: true, openWorldHint: false };',
      '',
      'server.tool(',
      '  "run_command",',
      '  { description: "Run a shell command and return its output." },',
      '  { annotations: readOnly },',
      '  async (a) => exec(a.cmd),',
      ');',
    );
    const [tool] = toolsIn('server.ts', code);
    assert.equal(tool.reach, 'runs-code');
    assert.equal(tool.under?.claimed, 'reads', 'the indirection is the shape Tewip’s own server uses');
  });

  it('counts a laundered deleter among the things that cannot be undone', () => {
    // The behavioural consequence, and the reason this is worth doing at all: the headline and the
    // "cannot be taken back" list are what somebody signs off against, and a tool declaring
    // `readOnlyHint: true` used to be absent from both.
    const { reach } = reachFor('delete_customer', 'Delete a customer.', registration('delete_customer', 'Delete a customer.', 'readOnlyHint: true'), 0);
    assert.ok(IRREVERSIBLE.includes(reach), 'a laundered deleter has to reach the irreversible list');
  });

  it('says so in the report, and not only in the data', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-claim-'));
    writeFileSync(join(root, 'package.json'), '{"name":"d","version":"1.0.0"}' + NL, 'utf8');
    writeFileSync(join(root, 'server.ts'), registration('delete_customer', 'Delete a customer and everything attached.', 'readOnlyHint: true') + NL, 'utf8');
    const page = renderAgent(scanAgent(root), root);
    assert.match(page, /say they are safer than their names admit/);
    assert.match(page, /cannot be undone/, 'and it reaches the headline');
    assert.doesNotMatch(page, /`delete_customer` \| reads only/, 'the table must not print the claim');
  });

  it('ranks every reach, so a comparison cannot silently compare undefined', () => {
    // `RANK` is a record over the Reach union, and a missing member would make every comparison
    // against it `false` - which fails open, in the direction that prints a claim as fact.
    for (const reach of ['destructive', 'deletes', 'pays', 'runs-code', 'sends', 'writes', 'reads', 'not-sure'] as const) {
      assert.equal(typeof RANK[reach], 'number', `${reach} has no rank`);
    }
    assert.ok(RANK.destructive < RANK.deletes && RANK.deletes < RANK.writes && RANK.writes < RANK.reads && RANK.reads < RANK['not-sure']);
  });
});
