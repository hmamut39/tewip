// Phase 139: what an AI agent is allowed to do, read from its source before it runs.
//
// The market this enters is full of tools that evaluate an agent by running it. They answer "is it
// any good". Nobody answers the one an IT department has to sign: what is it allowed to do, and
// what stands between it and the real world. That one is decidable by reading.
//
// Almost every test here is a defect that real code found. The checks were written against how
// frameworks document themselves, and then run against the official MCP servers, the OpenAI Agents
// SDK, crewAI and Tewip's own server, which is where they fell over - every time in the same two
// ways. Either prose was read as code (a docstring example, an apostrophe, a verb in a sentence
// about something else), or code was read as prose (a glob containing `/*`).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { reachOf, toolsIn, trifectaIn, type AgentTool } from '../agent/tools.ts';
import { guardsIn } from '../agent/guards.ts';
import { blank } from '../agent/source-text.ts';
import { renderAgent, scanAgent } from '../agent/agent-command.ts';

const NL = String.fromCharCode(10);
const names = (tools: AgentTool[]) => tools.map((t) => t.name).sort();

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-agent-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

describe('finding the tools an agent can call', () => {
  it('reads the MCP, AI SDK, OpenAI and Anthropic shapes', () => {
    const text = [
      `server.registerTool("delete_user", { description: "Deletes a user." });`,
      `const t = { sendMail: tool({ description: "Sends an email." }) };`,
      `const o = { type: "function", function: { name: "charge_card" } };`,
      `const a = { name: "read_file", description: "x", input_schema: {} };`,
    ].join(NL);
    assert.deepEqual(names(toolsIn('a.ts', text)), ['charge_card', 'delete_user', 'read_file', 'sendMail']);
  });

  it('reads the Python shapes', () => {
    const text = [
      '@tool',
      'def search_web(q: str) -> str:',
      '    return q',
      '',
      '@mcp.tool()',
      'async def delete_record(id: str):',
      '    pass',
      '',
      '@function_tool',
      'def send_invoice(to: str):',
      '    pass',
    ].join(NL);
    assert.deepEqual(names(toolsIn('a.py', text)), ['delete_record', 'search_web', 'send_invoice']);
  });

  it('does not read a documentation example as a tool', () => {
    // crewAI's own `@tool` decorator documents itself with `@tool` / `def greet(...)` inside its
    // docstring. Both came back as tools this agent can call. Neither exists.
    const text = [
      'def tool(*args):',
      '    """Decorator to create a Tool.',
      '',
      '    Example:',
      '        @tool',
      '        def greet(name: str) -> str:',
      "            '''Greet someone.'''",
      '            return name',
      '    """',
      '    pass',
    ].join(NL);
    assert.deepEqual(toolsIn('base_tool.py', text), []);
  });

  it('does not lose a tool to a glob that contains a comment marker', () => {
    // The other direction, and the one that matters more. Blanking from `/*` to the next `*/`
    // without knowing it was inside a string ate the code between two path patterns, and three
    // real tools vanished from the official MCP filesystem server: copy_file, move_file,
    // search_files. A tool that silently disappears is the worst output this command has.
    const text = [
      `const ignore = ["**/*", "node_modules/*"];`,
      `server.registerTool("copy_file", { description: "Copies a file." });`,
      `const more = ["dist/*"];`,
      `server.registerTool("search_files", { description: "Searches for files." });`,
    ].join(NL);
    assert.deepEqual(names(toolsIn('fs.ts', text)), ['copy_file', 'search_files']);
  });
});

describe('what a tool reaches', () => {
  it('believes the author over its own guess', () => {
    const inline = `server.registerTool("thing", { annotations: { readOnlyHint: true } });`;
    assert.equal(toolsIn('a.ts', inline)[0].reach, 'reads');
    const destructive = `server.registerTool("thing", { annotations: { destructiveHint: true } });`;
    assert.equal(toolsIn('a.ts', destructive)[0].reach, 'destructive');
  });

  it('follows an annotation written once and reused', () => {
    // How Tewip's own server does it, and the shape a check written from the documentation misses.
    const text = [
      'const readOnly = { readOnlyHint: true, destructiveHint: false };',
      'server.registerTool("compute_everything", { annotations: readOnly });',
    ].join(NL);
    assert.equal(toolsIn('a.ts', text)[0].reach, 'reads');
  });

  it('reads a verb in the third person', () => {
    // `\bread\b` does not match "Reads": the trailing s removes the word boundary. All seventeen
    // tools in Tewip's own server came back undecided while their descriptions said what they did.
    assert.equal(reachOf('vouch_tests', 'Reads test files and says, per test, whether').reach, 'reads');
    assert.equal(reachOf('x', 'Deletes the record and returns').reach, 'deletes');
    assert.equal(reachOf('x', 'Searches the index').reach, 'reads');
  });

  it('only believes the opening clause of a description', () => {
    // Tewip's own `explain_failure` mentions "history on this commit versus others" and was called
    // a tool that writes, on the strength of the word commit in a sentence about reading.
    //
    // The name here has to be one that decides nothing. Written with `explain_failure` this test
    // passed with the fix removed, because `explain` is itself a reading verb and the name settles
    // it before the description is ever consulted - a test that could not fail, guarding the thing
    // it was written for.
    const r = reachOf('what_happened_here', 'Everything known about one failing test: root cause, and history on this commit versus others.');
    assert.notEqual(r.reach, 'writes', 'a verb in prose later in the description is not what the tool does');
    assert.equal(r.reach, 'not-sure');
  });

  it('says undecided rather than guessing safe', () => {
    assert.equal(reachOf('what_tewip_may_do', '').reach, 'not-sure');
  });
});

describe('the lethal trifecta', () => {
  const tool = (name: string, capabilities: AgentTool['capabilities']): AgentTool =>
    ({ name, file: 'a.ts', line: 1, shape: 's', description: '', reach: 'reads', why: '', capabilities });

  it('is complete only when all three legs are there', () => {
    const all = [tool('fetch_url', ['untrusted-input']), tool('read_db', ['private-data']), tool('send_email', ['can-send-out'])];
    assert.equal(trifectaIn(all).complete, true);
    assert.equal(trifectaIn(all.slice(0, 2)).complete, false);
  });

  it('names the tools in each leg, so the claim can be checked', () => {
    const t = trifectaIn([tool('fetch_url', ['untrusted-input']), tool('read_db', ['private-data'])]);
    assert.deepEqual(names(t.legs['untrusted-input']), ['fetch_url']);
    assert.deepEqual(t.legs['can-send-out'], []);
  });

  it('counts one tool in every leg it supplies', () => {
    // `post_comment` reads somebody else's text and publishes text, which is two legs at once.
    const found = toolsIn('a.ts', `server.registerTool("post_comment", { description: "Posts a comment on an issue." });`);
    assert.ok(found[0].capabilities.includes('untrusted-input'));
    assert.ok(found[0].capabilities.includes('can-send-out'));
  });
});

describe('what stands between the tools and the real world', () => {
  it('does not read its own pattern as a gate', () => {
    // Run against Tewip, `asks-a-person` matched the word interrupt inside the regex that looks
    // for it, and the report said Tewip has a human approval gate. It does not.
    const text = `const PATTERNS = [/\\b(?:interrupt|human_in_the_loop)\\b/g];`;
    assert.deepEqual(guardsIn('guards.ts', text), []);
  });

  it('is not thrown off by an apostrophe in a comment', () => {
    // An apostrophe in prose opens a string that stays open, and every later line is one quote out
    // of step. This is why the self-match above survived a first attempt at fixing it.
    const text = [
      "// Tewip's own server does it this way.",
      'const x = 1;',
      'if (needs_approval) { stop(); }',
    ].join(NL);
    assert.deepEqual(guardsIn('a.ts', text).map((g) => g.kind), ['asks-a-person']);
  });

  it('finds a real gate written as code', () => {
    const found = guardsIn('a.py', 'if requires_approval:' + NL + '    wait()');
    assert.equal(found[0]?.kind, 'asks-a-person');
    assert.equal(found[0]?.line, 1);
  });

  it('keeps line numbers right after blanking', () => {
    const text = ['/* a', 'b */', 'const maxSteps = 5;'].join(NL);
    assert.equal(guardsIn('a.ts', text)[0].line, 3);
  });
});

describe('the report', () => {
  it('does not call test fixtures the agent tools', () => {
    // All 24 "tools" reported for the OpenAI Agents SDK were fixtures under integration_tests/ and
    // test_*.py - a directory ending in tests rather than named tests, and the Python convention
    // of putting the word at the front of the file.
    // `helpers.py` is the one that matters: every other fixture here is also caught by the
    // `test_*.py` filename rule, so written without it this test passed with the directory rule
    // removed - it was guarding a thing it never exercised.
    const root = project({
      'integration_tests/helpers.py': '@tool' + NL + 'def fake_fetch():' + NL + '    pass',
      'integration_tests/test_run.py': '@tool' + NL + 'def fake_delete():' + NL + '    pass',
      'src/test_helper.py': '@tool' + NL + 'def also_fake():' + NL + '    pass',
      'src/real.py': '@tool' + NL + 'def send_email():' + NL + '    pass',
    });
    assert.deepEqual(names(scanAgent(root).tools), ['send_email']);
  });

  it('does not exclude a directory merely because its name ends in those letters', () => {
    const root = project({ 'latest/real.py': '@tool' + NL + 'def send_email():' + NL + '    pass' });
    assert.deepEqual(names(scanAgent(root).tools), ['send_email']);
  });

  it('says what it looked for when it finds nothing', () => {
    const page = renderAgent({ tools: [], guards: [], filesRead: 9, emptyBudget: null }, '.');
    assert.match(page, /No tool definitions were found in 9 file/);
    assert.match(page, /not a finding that this agent has no tools/);
    assert.match(page, /MCP SDKs/);
  });

  it('leads with the trifecta when all three legs are present', () => {
    const root = project({
      'src/a.ts': [
        `server.registerTool("fetch_url", { description: "Fetches a web page." });`,
        `server.registerTool("read_db", { description: "Reads the customer database." });`,
        `server.registerTool("send_email", { description: "Sends an email." });`,
      ].join(NL),
    });
    const page = renderAgent(scanAgent(root), root);
    assert.match(page, /all three legs of the lethal trifecta/);
    assert.match(page, /A system prompt is not a defence here/);
  });

  it('says plainly when nothing asks a person', () => {
    const root = project({ 'src/a.ts': `server.registerTool("delete_all", { description: "Deletes everything." });` });
    const page = renderAgent(scanAgent(root), root);
    assert.match(page, /nothing in this project stops to ask a person/);
    assert.match(page, /\*\*asks-a-person\*\* — nothing found anywhere/);
  });

  it('names what it did not check', () => {
    const root = project({ 'src/a.ts': `server.registerTool("x", { description: "Reads a thing." });` });
    const page = renderAgent(scanAgent(root), root);
    assert.match(page, /What this does not check/);
    assert.match(page, /means somebody wrote one, not that the refund tool is behind it/);
    assert.match(page, /Silence about a framework is silence, not approval/);
  });
});

describe('the source scanner', () => {
  it('keeps string contents for code and blanks them for calls', () => {
    const { code, calls } = blank('const a = "interrupt";', false);
    assert.match(code, /interrupt/);
    assert.doesNotMatch(calls, /interrupt/);
  });

  it('keeps every index pointing where it did', () => {
    const text = 'const a = "xyz"; // note' + NL + 'const b = 2;';
    const { code, calls } = blank(text, false);
    assert.equal(code.length, text.length);
    assert.equal(calls.length, text.length);
    assert.equal(code.split(NL).length, text.split(NL).length);
  });
});
