// The counted claims in the two plugin READMEs, held to what the plugin actually ships.
//
// Phase 229. `plugin-standalone/README.md` is the text published at hmamut39/tewip-plugin, which is
// the page somebody reads before installing. It said "a manifest, three skills" and "19 tools"
// while the directory beside it held five skills and the server registered 25 - and the main
// README said "three skills" too. Both sentences were true when they were written, and nothing
// re-derived either, which is the same stale-by-omission shape this project keeps finding in its
// own documents.
//
// The tool count is counted rather than asserted, and this test fails if it meets a registration
// shape it cannot read. That matters more than the number: `mcp/server.ts` registers eighteen
// tools by name and seven more from two `as const` tables in loops, so a test that only understood
// the first shape would have undercounted by seven and called the README wrong when it was right.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const HERE = join(import.meta.dirname, '..', '..');
const NL = String.fromCharCode(10);
const read = (...p: string[]) => readFileSync(join(HERE, ...p), 'utf8');

/** Every tool name the MCP server registers, in both shapes it uses. */
function servedTools(): Set<string> {
  const dir = join(HERE, 'mcp');
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join(NL);

  // Shape one: the name written at the call.
  const direct = [...all.matchAll(/registerTool\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  // Shape two: `for (const [name, ...] of TABLE)` with a `registerTool(name, ...)` inside.
  const loops = [...all.matchAll(/for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*(\w+)\s*\)/g)].map((m) => m[1]);
  const fromTables = loops.flatMap((table) => {
    const rows = new RegExp(String.raw`const\s+${table}\s*=\s*\[([\s\S]*?)\]\s*as const`).exec(all)?.[1] ?? '';
    return [...rows.matchAll(/\[\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  });

  // The guard on the guard. Every `registerTool(` in the tree is either a direct call or the one
  // inside a loop this test found, so a third shape added later fails here instead of quietly
  // making the count too low - which would report the README as wrong while it was right.
  const callSites = [...all.matchAll(/registerTool\(/g)].length;
  assert.equal(
    callSites,
    direct.length + loops.length,
    `there are ${callSites} registerTool( call sites and this test can read ${direct.length + loops.length} of them. A registration shape was added that it does not understand, so the tool count below cannot be trusted.`,
  );
  return new Set([...direct, ...fromTables]);
}

const WORDS: Record<number, string> = { 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' };

describe('what the plugin READMEs claim about the plugin', () => {
  const skills = readdirSync(join(HERE, 'plugin-standalone', 'skills')).length;

  it('counts the same skills in both copies of the plugin', () => {
    assert.equal(readdirSync(join(HERE, 'plugin', 'skills')).length, skills, 'the two plugin copies ship different numbers of skills');
  });

  for (const where of ['README.md', join('plugin-standalone', 'README.md')]) {
    it(`says how many skills the plugin has, correctly, in ${where}`, () => {
      const text = read(where);
      const word = WORDS[skills];
      assert.ok(word, `no word for ${skills} skills - add it above`);
      // Every count-word that appears next to "skills" has to be the right one. Matching the right
      // word alone would pass a document that says both "five skills" and "three skills", which is
      // exactly how this drifted: one sentence was updated and the other was not.
      // Anchored to "plugin", and not crossing a full stop. A bare `(count) skills` also matched
      // "answers JSON-RPC `SendMessage`, with eight skills: triage, vouch, pick..." - the A2A agent
      // card, which really does advertise eight and has nothing to do with the plugin. Twice now a
      // counted-claim guard has reported a true sentence as wrong by matching a number that was
      // about something else, which is its own way of being a check nobody trusts.
      const claims = [...text.replace(/\s+/g, ' ').matchAll(/plugin[^.]{0,80}?\b(three|four|five|six|seven|eight|\d+) skills\b/gi)].map((m) => m[1].toLowerCase());
      assert.ok(claims.length > 0, `${where} no longer says how many skills the plugin has`);
      const wrong = claims.filter((c) => c !== word && c !== String(skills));
      assert.deepEqual(wrong, [], `${where} claims "${wrong.join('", "')} skills" and the plugin ships ${skills}`);
    });
  }

  it('says how many tools the MCP server serves, correctly, in both READMEs', () => {
    const tools = servedTools();
    for (const where of ['README.md', join('plugin-standalone', 'README.md')]) {
      // Anchored to the two places that are claims about *this* server. A bare `(\d+) tools` also
      // matched "The official MCP servers: 27 tools, 6 that cannot be undone" - a measurement of
      // somebody else's servers, in the agent section - and this test reported the README as
      // overstating Tewip by two when the sentence was about other people entirely.
      const claims = [...read(where).replace(/\s+/g, ' ').matchAll(/(?:tewip mcp|\*\*The MCP server\*\*)[^|]{0,60}?(\d+) tools/g)].map((m) => Number(m[1]));
      assert.ok(claims.length > 0, `${where} no longer says how many tools the MCP server serves`);
      const wrong = claims.filter((n) => n !== tools.size);
      assert.deepEqual(wrong, [], `${where} claims ${wrong.join(', ')} tool(s) and the server registers ${tools.size}`);
    }
  });

  it('names every skill it describes, so a skill cannot be shipped unmentioned', () => {
    // The sentence in both READMEs lists what each skill is *for*, and a count alone would let a
    // fifth skill ship with four descriptions beside it. These are the triggers, in the words the
    // READMEs use.
    const described: Record<string, RegExp> = {
      'verify-before-done': /before claiming a change is done/,
      'explain-a-failure': /when a test fails/,
      'check-a-migration': /when a change touches a migration/,
      'is-this-slower': /something may have got slower/,
      'is-it-usable-by-everybody': /an interface somebody has to be able to use/,
    };
    const shipped = readdirSync(join(HERE, 'plugin-standalone', 'skills')).sort();
    assert.deepEqual(shipped, Object.keys(described).sort(), 'a skill was added or removed and the READMEs still describe the old set');
    for (const where of ['README.md', join('plugin-standalone', 'README.md')]) {
      // Whitespace collapsed first. A README wraps its lines, so a phrase that reads as one
      // sentence to a person is split by a line break in the file - and this test failed on the
      // very sentence it was written to hold, because the wrap fell in the middle of it.
      const text = read(where).replace(/\s+/g, ' ');
      const missing = Object.entries(described)
        .filter(([, says]) => !says.test(text))
        .map(([name]) => name);
      assert.deepEqual(missing, [], `${where} ships ${missing.join(', ')} without saying when to reach for it`);
    }
  });

  it('does not claim either repository is private, because both are public', () => {
    // The main README said the plugin repository holding only a manifest and a pointer "is why this
    // one can stay private". Both hmamut39/tewip and hmamut39/tewip-plugin are public, so that
    // sentence told a reader something false about where their code goes.
    assert.doesNotMatch(read('README.md'), /can stay private/, 'the README claims a repository is private and neither is');
  });
});
