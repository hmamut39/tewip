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
import { ANY_SOURCE, SOURCES, promptFlows as promptFlowsOf } from '../agent/prompt-flow.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { reachOf, toolsIn, trifectaIn, type AgentTool } from '../agent/tools.ts';
import { guardsIn } from '../agent/guards.ts';
import { blank } from '../agent/source-text.ts';
import { promptFlows } from '../agent/prompt-flow.ts';
import { scanConfig } from '../agent/claude-config.ts';
import { coverageOf, evalEvidence } from '../agent/tool-tests.ts';
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
    const page = renderAgent({ tools: [], injections: [], guards: [], filesRead: 9, emptyBudget: null, config: { read: [], findings: [], servers: [], hasAllowList: false, hasEnforcedHook: false }, coverage: [], evals: { frameworks: [], files: [] } }, '.');
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

// Phase 140: the same question one level down.
//
// The trifecta is an argument about what *could* happen, from the tool list. This is about what the
// code does: is text from a web page, a ticket, an inbox or a retriever glued into the prompt
// string itself. Glued, not passed beside it - the distinction matters more here than it does in
// SQL, because a prompt has no parameter binding to fall back on.
//
// On 1,691 files of real agent code - the official MCP servers, the OpenAI Agents SDK, CrewAI and
// Tewip's own server - this finds nothing, which is the precision claim. Those projects pass the
// outside text beside the prompt rather than into it. So recall is measured here, against planted
// examples, and said to be measured that way.
describe('text somebody else wrote, reaching a prompt', () => {
  const py = (...lines: string[]) => lines.join(NL);

  it('catches a fetched page glued in with an f-string', () => {
    const found = promptFlows('a.py', py(
      'def summarise(url):',
      '    page = requests.get(url).text',
      '    return client.messages.create(tools=TOOLS, messages=[{"content": f"Read: {page}"}])',
    ));
    assert.equal(found.length, 1);
    assert.equal(found[0].origin, 'a web page this agent fetched');
    assert.match(found[0].through, /f-string/);
    assert.equal(found[0].withTools, true);
  });

  it('catches a template literal in JavaScript', () => {
    const found = promptFlows('a.ts', py(
      'async function run(url) {',
      '  const html = await fetch(url).then((r) => r.text());',
      '  return client.messages.create({ tools, messages: [{ content: `Read: ${html}` }] });',
      '}',
    ));
    assert.equal(found.length, 1);
    assert.match(found[0].through, /template literal/);
    assert.equal(found[0].withTools, true, '{ tools, messages } is the shorthand both SDKs use');
  });

  it('catches a retrieved document and a ticket body', () => {
    const docs = promptFlows('a.py', py('def f(q):', '    hits = retriever.invoke(q)', '    return llm.invoke(f"Context: {hits}")'));
    assert.equal(docs[0]?.origin, 'a document this agent retrieved');
    const ticket = promptFlows('b.py', py('def f(issue):', '    body = issue.body', '    return llm.invoke(f"Fix: {body}")'));
    assert.equal(ticket[0]?.origin, 'a ticket or comment somebody else wrote');
  });

  it('says nothing when the text is passed beside the prompt instead of into it', () => {
    // The whole distinction. This is what every real project in the corpus does, and why the
    // precision number is zero rather than a page of findings somebody would switch off.
    assert.deepEqual(promptFlows('a.py', py(
      'def summarise(url):',
      '    page = requests.get(url).text',
      '    return client.messages.create(messages=[{"role": "user", "content": page}])',
    )), []);
  });

  it('does not join a source and a prompt in different functions', () => {
    assert.deepEqual(promptFlows('a.ts', py(
      'function a(url) { const html = fetch(url).then((r) => r.text()); }',
      'function b() { return client.create({ tools, messages: [{ content: `x ${html}` }] }); }',
    )), []);
  });

  it('separates exposure from reach', () => {
    const noTools = promptFlows('a.ts', py(
      'async function run(url) {',
      '  const html = await fetch(url).then((r) => r.text());',
      '  return client.messages.create({ messages: [{ content: `Read: ${html}` }] });',
      '}',
    ));
    assert.equal(noTools.length, 1);
    assert.equal(noTools[0].withTools, false, 'a wrong answer is not the same as a tool call somebody else chose');
  });

  it('reports one finding per untrusted value, not per mention of a prompt', () => {
    // `messages=` and `.create(` both match the same statement; reporting it twice reads as two
    // separate problems in a report somebody is deciding what to fix from.
    const found = promptFlows('a.py', py(
      'def f(url):',
      '    page = requests.get(url).text',
      '    return client.messages.create(',
      '        tools=TOOLS,',
      '        messages=[{"content": f"Read: {page}"}],',
      '    )',
    ));
    assert.equal(found.length, 1);
  });
});

// Phase 141: the permissions an installed coding agent was given in this repository.
//
// A rule written in a markdown file is a request to the model. A permission in settings.json is
// enforced by the harness on every tool call. They look equally like configuration and they are
// not the same kind of thing, and only one of them is a control an auditor can rely on.
//
// All of these files are committed, and anybody with write access can change them without it
// looking like a code change.
describe('what the coding agent here is permitted to do', () => {
  const settings = (json: unknown) => ({ '.claude/settings.json': JSON.stringify(json, null, 2) });

  it('names the gate being switched off', () => {
    const scan = scanConfig(project(settings({ permissions: { defaultMode: 'bypassPermissions' } })));
    assert.deepEqual(scan.findings.map((f) => f.rule), ['permissions-bypassed']);
    assert.match(scan.findings[0].why, /without asking/);
  });

  it('tells an unconstrained shell from a named command', () => {
    const open = scanConfig(project(settings({ permissions: { allow: ['Bash'] } })));
    assert.deepEqual(open.findings.map((f) => f.rule), ['shell-unconstrained']);
    const chosen = scanConfig(project(settings({ permissions: { allow: ['Bash(npm run test:*)', 'Read(./src)'] } })));
    assert.deepEqual(chosen.findings, [], 'a named command is a decision somebody made');
    assert.equal(chosen.hasAllowList, true, 'and the list itself is an allow-list');
  });

  it('locates a committed credential without printing it', () => {
    // The standing rule everywhere in Tewip: a secret is located, never quoted.
    const scan = scanConfig(project(settings({ env: { GITHUB_TOKEN: 'ghp_averyrealsecret' } })));
    assert.deepEqual(scan.findings.map((f) => f.rule), ['secret-in-settings']);
    const page = scan.findings.map((f) => f.what + f.why).join(' ');
    assert.doesNotMatch(page, /averyrealsecret/);
  });

  it('does not call a reference to a variable a committed credential', () => {
    assert.deepEqual(scanConfig(project(settings({ env: { API_KEY: '$MY_KEY' } }))).findings, []);
  });

  it('reads the tool servers, and says which are somebody else’s machine', () => {
    const root = project({
      '.mcp.json': JSON.stringify({ mcpServers: { local: { command: 'npx', args: ['-y', 'x'] }, vendor: { url: 'https://tools.example.com/mcp' } } }),
    });
    const scan = scanConfig(root);
    assert.deepEqual(scan.servers.map((s) => [s.name, s.where]), [['local', 'this machine'], ['vendor', 'somewhere else']]);
  });

  it('counts a PreToolUse hook as a gate, because the harness enforces it', () => {
    const withHook = scanConfig(project(settings({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } })));
    assert.equal(withHook.hasEnforcedHook, true);
    const after = scanConfig(project(settings({ hooks: { PostToolUse: [{ matcher: 'Bash' }] } })));
    assert.equal(after.hasEnforcedHook, false, 'a hook that runs afterwards observes, it does not refuse');
  });

  it('says nothing about files that are not there', () => {
    const scan = scanConfig(project({ 'src/a.ts': 'export const a = 1;' }));
    assert.deepEqual(scan.read, []);
    assert.deepEqual(scan.findings, []);
  });

  it('reports a permission problem even when the project has no agent tools of its own', () => {
    // The two are independent. A repository with no agent code can still hand a coding agent a
    // shell with no constraint on the command, and that is a finding about this repository.
    const root = project({ ...settings({ permissions: { defaultMode: 'bypassPermissions' } }), 'src/a.ts': 'export const a = 1;' });
    const page = renderAgent(scanAgent(root), root);
    assert.match(page, /No tool definitions were found/);
    assert.match(page, /permissions-bypassed/);
  });
});

// Phase 142: which of these tools anybody wrote a test about.
//
// "No eval set" is on every list of what separates a demo from a product, and it is usually
// offered as something to feel bad about. The checkable version is narrower and more useful: not
// "does this project have tests" - every project has tests - but **is this particular tool
// mentioned in any of them**, and especially the ones that cannot be undone.
describe('which tools anybody wrote a test about', () => {
  const tests = (text: string) => [{ file: 'a.test.ts', text }];

  it('finds a tool nobody mentions', () => {
    const c = coverageOf(['refund_payment', 'list_orders'], tests('it("lists", () => list_orders());'));
    assert.deepEqual(c.find((x) => x.name === 'refund_payment')?.mentionedIn, []);
    assert.deepEqual(c.find((x) => x.name === 'list_orders')?.mentionedIn, ['a.test.ts']);
  });

  it('does not let a longer name cover a shorter one', () => {
    // `delete_user_profile` being tested says nothing about `delete_user`, which is a different
    // tool and may be the dangerous one.
    const c = coverageOf(['delete_user'], tests('it("x", () => delete_user_profile());'));
    assert.deepEqual(c[0].mentionedIn, []);
  });

  it('refuses to decide on a name too common to look for', () => {
    // A tool called `get` appears in every file, so finding it in a test proves nothing. Counting
    // it as covered is the comfortable direction and the wrong one.
    const c = coverageOf(['get', 'fetch_customer_ledger'], tests('const x = get(1);'));
    assert.equal(c[0].tooCommon, true);
    assert.deepEqual(c[0].mentionedIn, [], 'and it is not quietly counted as covered');
    assert.equal(c[1].tooCommon, false);
  });

  it('names the eval frameworks it looked for, so silence can be read', () => {
    const none = evalEvidence([{ file: 'a.test.ts', text: 'assert(1);' }], ['{"devDependencies":{}}']);
    assert.deepEqual(none.frameworks, []);
    const some = evalEvidence([], ['{"devDependencies":{"promptfoo":"^0.1.0"}}']);
    assert.deepEqual(some.frameworks, ['promptfoo']);
  });

  it('spots an eval set by where it lives', () => {
    const e = evalEvidence([{ file: 'evals/checkout.yaml', text: 'x' }, { file: 'src/a.test.ts', text: 'y' }], []);
    assert.deepEqual(e.files, ['evals/checkout.yaml']);
  });

  it('reads test files rather than skipping them, which is the whole check', () => {
    // The first version excluded test files from the scan and then asked which tools appeared in
    // them. Nothing did, so every tool in every project came back untested - including the
    // official MCP servers, which test all of theirs.
    const root = project({
      'src/a.ts': `server.registerTool("refund_payment", { description: "Refunds." });` + NL + `server.registerTool("list_orders", { description: "Lists orders." });`,
      'src/__tests__/a.test.ts': 'it("lists", () => list_orders());',
    });
    const scan = scanAgent(root);
    assert.equal(scan.coverage.find((c) => c.name === 'list_orders')?.mentionedIn.length, 1);
    assert.equal(scan.coverage.find((c) => c.name === 'refund_payment')?.mentionedIn.length, 0);
  });

  it('says what a missing name does and does not mean', () => {
    const root = project({ 'src/a.ts': `server.registerTool("refund_payment", { description: "Refunds a payment." });` });
    const page = renderAgent(scanAgent(root), root);
    assert.match(page, /appear in no test file/);
    assert.match(page, /not a tool whose\s+behaviour is untested/);
    assert.match(page, /by that name/);
  });
});

// Phase 152: the gate that was added to make this check cheap, and became its second-largest cost.
//
// `promptFlows` asks one cheap question before the expensive work - is there any untrusted source
// in this file at all - and a CPU profile of `tewip agent` on n8n put that single regex at 6.3 of
// 37 seconds. Six of the eight source patterns open with `\w*`, which is there so a reported
// source reads `issue.body` rather than `sue.body` when the variable is `myissue`. For a yes-or-no
// question it contributes nothing and costs nearly everything: the engine tries `\w*` at every
// position in the file and backtracks. The gate drops those prefixes.
//
// Which is only safe while the gate and the patterns agree, so that is what this measures rather
// than asserts. A pattern added later whose stripped form is *narrower* than the pattern would
// silently stop this check finding anything in files it used to read - a check going quiet, which
// is the failure this project is most afraid of, because it looks exactly like good news.
describe('the cheap gate in front of the prompt-flow scan', () => {
  const fullUnion = new RegExp(SOURCES.map((s) => `(?:${s.re})`).join('|'));

  it('is actually cheaper than the patterns it guards', () => {
    assert.ok(
      ANY_SOURCE.source.length < fullUnion.source.length,
      'the gate is no shorter than the full union, so nothing was stripped and the cost is still there',
    );
  });

  it('says yes wherever any source pattern says yes', () => {
    // One line per source in SOURCES, in the shape its own framework documents, each with the
    // `\w*` prefix in play so the stripping is what is being tested.
    const realistic = [
      'r = requests.get(url).text',
      'const d = await fetch(url).json()',
      'body = mypage.get_text()',
      'hits = myretriever.invoke(question)',
      'text = mydoc.page_content',
      'msg = myissue.body',
      'raw = myemail.get_payload()',
      'summary = my_tool_result',
      'soup.content',
      'ticket.description',
      'store.query(q)',
      'observation',
    ];
    for (const line of realistic) {
      assert.equal(ANY_SOURCE.test(line), fullUnion.test(line), `the gate and the patterns disagree about: ${line}`);
      assert.ok(fullUnion.test(line), `this sample no longer matches any source pattern, so it tests nothing: ${line}`);
    }
  });

  it('says no to ordinary code, which is the whole point of asking', () => {
    for (const line of ['const x = 1', 'return a + b;', 'import os', 'nothing here at all']) {
      assert.equal(ANY_SOURCE.test(line), false, `the gate lets through ordinary code, so it filters nothing: ${line}`);
      assert.equal(fullUnion.test(line), false);
    }
  });

  it('still finds a flow through a prefixed variable, end to end', () => {
    // The gate is upstream of everything, so a false negative there is silent. This goes through
    // promptFlows itself rather than the regex.
    const found = promptFlows(
      'bot.py',
      ['def handle(myissue, client):', '    body = myissue.body', '    return client.create(messages=f"Summarise: {body}", tools=TOOLS)'].join('\n'),
    );
    assert.equal(found.length, 1, `expected one flow through a prefixed variable, got ${JSON.stringify(found)}`);
    assert.equal(found[0].withTools, true);
  });
});

// Phase 152: one finding per flow, however many ways the scan reached it.
describe('a prompt-injection flow reported twice', () => {
  const flows = (body: string) => promptFlowsOf('handler.py', body);

  it('is reported once when the same value is assigned twice', () => {
    // Real n8n code: `message.content = (message.content ? message.content + "\n" : "") + content`
    // assigns from the same source more than once. The dedup key was the position of the
    // assignment, so each one produced a finding identical in file, line, source and route - the
    // same problem printed twice, which reads as two.
    const found = flows(['def go(ticket, client):', '    body = ticket.body', '    body = ticket.body', '    return client.invoke(f"x {body}", tools=T)'].join('\n'));
    assert.equal(found.length, 1, `expected one finding, got ${JSON.stringify(found.map((f) => f.through))}`);
  });

  it('still reports two routes when the code really wrote two', () => {
    // Directly inside the f-string and through a variable, in one statement. Those are two things
    // somebody wrote, so collapsing them would be hiding one.
    const found = flows(['def go(ticket, client):', '    body = ticket.body', '    return client.invoke(f"{ticket.body} and {body}", tools=T)'].join('\n'));
    assert.equal(found.length, 2);
    assert.equal(new Set(found.map((f) => f.through)).size, 2, 'the two findings must differ in how the value got in');
  });
});
