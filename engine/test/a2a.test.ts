// Phase 34: Tewip as a peer other agents must satisfy.
//
// Half of these tests exist because the A2A v1.0 shapes are not what they are usually remembered
// as, and each of the four would have produced a server nothing could talk to: the JSON-RPC method
// is `SendMessage` in PascalCase and not `message/send`; discovery is at
// `/.well-known/agent-card.json` and not `agent.json`; a role is `ROLE_USER`; a state is
// `TASK_STATE_COMPLETED`. They are pinned here so an upgrade that changes them fails loudly.
//
// The other half is the guardrails. This is an HTTP port that runs commands against somebody's
// repository, and the two rules that make that acceptable - only read-only skills are reachable,
// and anything it will not perform is declared false on the card - are worth a test each.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentCard, ANSWERABLE, skillById } from '../a2a/card.ts';
import { askWhich, chooseSkill, textOf } from '../a2a/answer.ts';
import { handleRpc, isLoopback } from '../a2a/serve.ts';

const CMD = { root: process.cwd(), port: 41241, host: '127.0.0.1', tewipRoot: process.cwd() };
const message = (text: string, metadata?: Record<string, unknown>) => ({
  messageId: 'm1',
  role: 'ROLE_USER',
  parts: [{ text }],
  ...(metadata ? { metadata } : {}),
});
const sendMessage = (msg: unknown) => handleRpc(CMD, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: msg } });
const taskOf = (r: { payload: unknown }) => (r.payload as { result: { task: Record<string, any> } }).result.task;
const errorOf = (r: { payload: unknown }) => (r.payload as { error: { code: number; message: string } }).error;

describe('the agent card says exactly what Tewip will do', () => {
  const card = agentCard('http://127.0.0.1:41241/a2a/v1', process.cwd());

  it('carries every field v1.0 requires', () => {
    for (const field of ['name', 'description', 'supportedInterfaces', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) {
      assert.ok(field in card, `a v1.0 AgentCard requires ${field}`);
    }
    assert.ok(card.supportedInterfaces.length > 0);
    assert.equal(card.supportedInterfaces[0].transport, 'JSONRPC');
  });

  it('every skill carries what a skill requires', () => {
    for (const skill of card.skills) {
      for (const field of ['id', 'name', 'description', 'tags']) assert.ok(field in skill, `${skill.id} is missing ${field}`);
      assert.ok(skill.tags.length > 0, `${skill.id} has no tags`);
      assert.ok(skill.description.length > 40, `${skill.id} has a description too thin to choose by`);
    }
  });

  it('declares false for everything it will not do', () => {
    assert.equal(card.capabilities.streaming, false);
    assert.equal(card.capabilities.pushNotifications, false);
  });

  it('advertises exactly the skills the server will answer, so the two cannot drift', () => {
    assert.deepEqual(card.skills.map((s) => s.id).sort(), ANSWERABLE.map((s) => s.id).sort());
  });

  it('exposes nothing that writes a file', () => {
    // The whole reason this port is acceptable. fix, write, build, pursue and prove all change
    // something on disk or run the suite; none may be reachable from a socket.
    const forbidden = ['fix', 'write', 'build', 'pursue', 'prove', 'correct', 'jira'];
    for (const skill of ANSWERABLE) {
      assert.ok(!forbidden.includes(skill.verb), `${skill.verb} changes things and must not be reachable over A2A`);
    }
  });
});

describe('the JSON-RPC surface', () => {
  it('answers SendMessage, in the PascalCase the specification uses', () => {
    const r = sendMessage(message('is this work done', { skillId: 'house-standards' }));
    assert.equal(taskOf(r).status.state, 'TASK_STATE_COMPLETED');
  });

  it('rejects the older spelling rather than quietly accepting it', () => {
    const r = handleRpc(CMD, { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
    assert.equal(errorOf(r).code, -32601);
    assert.match(errorOf(r).message, /SendMessage only/);
  });

  it('refuses to stream, because its card says it does not', () => {
    for (const method of ['SendStreamingMessage', 'SubscribeToTask']) {
      const r = handleRpc(CMD, { jsonrpc: '2.0', id: 1, method, params: {} });
      assert.equal(errorOf(r).code, -32004, method);
      assert.match(errorOf(r).message, /streaming false|does not stream/);
    }
  });

  it('refuses push notifications for the same reason', () => {
    const r = handleRpc(CMD, { jsonrpc: '2.0', id: 1, method: 'CreateTaskPushNotificationConfig', params: {} });
    assert.equal(errorOf(r).code, -32004);
  });

  it('needs a message', () => {
    const r = handleRpc(CMD, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} });
    assert.equal(errorOf(r).code, -32602);
  });

  it('returns the verdict as an artifact, in markdown', () => {
    const task = taskOf(sendMessage(message('anything', { skillId: 'house-standards' })));
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.artifacts[0].parts[0].mediaType, 'text/markdown');
    assert.ok(task.artifacts[0].parts[0].text.length > 0);
    assert.ok(task.artifacts[0].artifactId, 'an artifact requires an artifactId');
  });
});

describe('it asks rather than guessing', () => {
  it('a vague message comes back as a question, not a guess', () => {
    const task = taskOf(sendMessage(message('check my code please')));
    assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.equal(task.status.message.role, 'ROLE_AGENT');
    assert.match(task.status.message.parts[0].text, /will not guess/);
  });

  it('an empty message is a question too', () => {
    assert.equal(taskOf(sendMessage(message(''))).status.state, 'TASK_STATE_INPUT_REQUIRED');
  });

  it('a skill it does not have is a question, never an error the caller cannot act on', () => {
    const task = taskOf(sendMessage(message('x', { skillId: 'delete-everything' })));
    assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.match(task.status.message.parts[0].text, /not a skill Tewip has/);
  });

  it('the question lists what it can actually answer, so the caller can retry', () => {
    const asked = askWhich('nothing named a skill');
    for (const skill of ANSWERABLE) assert.ok(asked.includes(skill.id), `${skill.id} missing from the question`);
  });

  it('a named skill is taken at its word, whatever the words say', () => {
    const choice = chooseSkill(message('something about databases', { skillId: 'accessibility' }));
    assert.equal(choice.kind, 'skill');
    assert.equal(choice.kind === 'skill' && choice.skill.id, 'accessibility');
  });

  it('a clear message picks the obvious skill without being told', () => {
    const choice = chooseSkill(message('is this database migration safe to deploy'));
    assert.equal(choice.kind, 'skill');
    assert.equal(choice.kind === 'skill' && choice.skill.id, 'migration-safety');
  });

  it('reads the text out of A2A parts, where text sits on the part itself', () => {
    assert.equal(textOf({ parts: [{ text: 'one' }, { data: { x: 1 } }, { text: 'two' }] }), 'one two');
    assert.equal(textOf({ parts: [] }), '');
    assert.equal(textOf({}), '');
  });

  it('accepts a skill named in a data part as well as in metadata', () => {
    const choice = chooseSkill({ messageId: 'm', role: 'ROLE_USER', parts: [{ data: { skillId: 'is-it-slower' } }] });
    assert.equal(choice.kind === 'skill' && choice.skill.id, 'is-it-slower');
  });
});

describe('where it will listen', () => {
  it('knows which addresses only this machine can reach', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(isLoopback(host), true, host);
    for (const host of ['0.0.0.0', '192.168.1.10', 'example.com']) assert.equal(isLoopback(host), false, host);
  });

  it('every advertised skill resolves to one Tewip can run', () => {
    for (const skill of ANSWERABLE) {
      assert.equal(skillById(skill.id)?.verb, skill.verb);
    }
  });
});
