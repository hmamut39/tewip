// Phase 34: serving Tewip to other agents over A2A.
//
// This is an HTTP port that runs commands against somebody's repository, so the guardrails are the
// design rather than a footnote:
//
//   - **It listens on 127.0.0.1 and nowhere else** unless a person passes --host deliberately, and
//     it says so loudly when they do. A quality tool that quietly opened a port on 0.0.0.0 would be
//     a worse problem than any bug it found.
//   - **Only the read-only skills are reachable.** The allowlist lives in card.ts; `fix`, `write`,
//     `build`, `pursue` and `prove` are not on it, because they change files or run the suite.
//   - **Every request is written to `.tewip/a2a.jsonl`**, the same way `pursue` records what it did,
//     so there is a record of what another agent asked for and what it was told.
//
// The shapes below are v1.0's: method `SendMessage` in PascalCase, roles `ROLE_USER`/`ROLE_AGENT`,
// states like `TASK_STATE_COMPLETED`, and a Part carrying exactly one of text/raw/url/data.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentCard } from './card.ts';
import { askWhich, chooseSkill, runSkill, type A2AMessage } from './answer.ts';

export interface A2ACommand {
  /** The project Tewip answers about. */
  root: string;
  port: number;
  /** Deliberately not configurable by accident: anything but a loopback address is announced. */
  host: string;
  /** Where Tewip's own code lives, for the version on the card. */
  tewipRoot: string;
}

const JSONRPC_PATH = '/a2a/v1';
const CARD_PATH = '/.well-known/agent-card.json';

/** A2A's own error numbers sit outside the JSON-RPC reserved range; -32601 is "no such method". */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNSUPPORTED = -32004;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** A completed task carrying the verdict as one artifact, which is what A2A expects back. */
function completedTask(text: string, failed: boolean): Record<string, unknown> {
  return {
    task: {
      id: randomUUID(),
      contextId: randomUUID(),
      status: { state: failed ? 'TASK_STATE_FAILED' : 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
      artifacts: [
        {
          artifactId: randomUUID(),
          name: 'verdict',
          description: "Tewip's answer, in the same words it would print for a person",
          parts: [{ text, mediaType: 'text/markdown' }],
        },
      ],
    },
  };
}

/** A task that stops and asks, which is how Tewip declines to guess what was meant. */
function needsInput(text: string): Record<string, unknown> {
  return {
    task: {
      id: randomUUID(),
      contextId: randomUUID(),
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        timestamp: new Date().toISOString(),
        message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }] },
      },
    },
  };
}

function record(root: string, entry: Record<string, unknown>): void {
  try {
    const path = join(root, '.tewip', 'a2a.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // A log that cannot be written must not stop an answer being given.
  }
}

function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((done, fail) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > limit) {
        fail(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => done(body));
    req.on('error', fail);
  });
}

/** Everything the server does with one JSON-RPC call, kept apart from the socket for testing. */
export function handleRpc(cmd: A2ACommand, body: unknown): { status: number; payload: unknown } {
  if (typeof body !== 'object' || body === null) return { status: 400, payload: rpcError(null, INVALID_PARAMS, 'the body is not a JSON-RPC object') };
  const call = body as Record<string, unknown>;
  const id = call.id ?? null;
  const method = typeof call.method === 'string' ? call.method : '';

  // The card says streaming and push notifications are false, and the specification requires an
  // operation whose flag is false to fail rather than silently behave differently.
  if (method === 'SendStreamingMessage' || method === 'SubscribeToTask') {
    return { status: 200, payload: rpcError(id, UNSUPPORTED, 'this agent does not stream; its card declares capabilities.streaming false. Use SendMessage.') };
  }
  if (method.includes('PushNotificationConfig')) {
    return { status: 200, payload: rpcError(id, UNSUPPORTED, 'this agent does not push; its card declares capabilities.pushNotifications false.') };
  }
  if (method !== 'SendMessage') {
    return { status: 200, payload: rpcError(id, METHOD_NOT_FOUND, `this agent answers SendMessage only, and was asked for "${method}"`) };
  }

  const params = (call.params ?? {}) as Record<string, unknown>;
  const message = (params.message ?? null) as A2AMessage | null;
  if (message === null || typeof message !== 'object') {
    return { status: 200, payload: rpcError(id, INVALID_PARAMS, 'params.message is required') };
  }

  const choice = chooseSkill(message);
  if (choice.kind === 'ask') {
    record(cmd.root, { http: 'POST', path: JSONRPC_PATH, method, outcome: 'asked-back', why: choice.why });
    return { status: 200, payload: { jsonrpc: '2.0', id, result: needsInput(askWhich(choice.why)) } };
  }
  if (choice.kind === 'unknown') {
    record(cmd.root, { http: 'POST', path: JSONRPC_PATH, method, outcome: 'unknown-skill', asked: choice.asked });
    return { status: 200, payload: { jsonrpc: '2.0', id, result: needsInput(askWhich(`"${choice.asked}" is not a skill Tewip has`)) } };
  }

  const answered = runSkill(cmd.root, choice.skill, []);
  record(cmd.root, { http: 'POST', path: JSONRPC_PATH, method, outcome: 'answered', skill: choice.skill.id, verb: choice.skill.verb, failed: answered.failed });
  return { status: 200, payload: { jsonrpc: '2.0', id, result: completedTask(answered.text, answered.failed) } };
}

/** True of an address that only this machine can reach. */
export const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1';

export function serveA2A(cmd: A2ACommand): ReturnType<typeof createServer> {
  const root = resolve(cmd.root);
  const url = `http://${cmd.host}:${cmd.port}${JSONRPC_PATH}`;

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    // What reaches the port, not only what gets answered.
    //
    // `record` was called from the three places inside the answering path, so the log held
    // successful answers and nothing else. Measured by sending four requests and finding one: a POST
    // to the wrong path, a JSON-RPC call for a method this agent does not have, and a malformed body
    // all left **no trace at all**. On a port with no authentication those are the entries worth
    // keeping - a peer probing for methods is exactly what an operator needs to see - and the file's
    // own comment promises "a record of what another agent asked for and what it was told". A
    // rejected request is still something another agent asked for.
    //
    // The request's body is never recorded, only what it asked for and how it was answered, because
    // a body from another agent can contain anything.
    const seen = (outcome: string, extra: Record<string, unknown> = {}) =>
      record(root, { http: req.method ?? '', path, outcome, ...extra });

    if (req.method === 'GET' && path === CARD_PATH) {
      seen('card-read');
      send(res, 200, agentCard(url, cmd.tewipRoot));
      return;
    }
    if (req.method !== 'POST' || path !== JSONRPC_PATH) {
      seen('no-such-endpoint');
      send(res, 404, { error: `nothing here. The card is at ${CARD_PATH} and calls go to ${JSONRPC_PATH}` });
      return;
    }
    readBody(req)
      .then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          seen('body-not-json');
          send(res, 400, rpcError(null, INVALID_PARAMS, 'the body is not JSON'));
          return;
        }
        const { status, payload } = handleRpc({ ...cmd, root }, parsed);
        // A JSON-RPC error rides in a 200 response - the transport worked, the call did not - so the
        // HTTP status cannot be the test. Checking it missed exactly the entry worth having: a peer
        // asking for a method this agent does not implement.
        const rpc = (payload as { error?: { message?: string }; result?: unknown }) ?? {};
        if (rpc.error) seen('refused', { why: rpc.error.message ?? '' });
        send(res, status, payload);
      })
      .catch((error: Error) => {
        seen('body-rejected', { why: error.message });
        send(res, 413, rpcError(null, INVALID_PARAMS, error.message));
      });
  });

  server.listen(cmd.port, cmd.host, () => {
    console.log(`Tewip is answering other agents about ${root}`);
    console.log(`  card:  http://${cmd.host}:${cmd.port}${CARD_PATH}`);
    console.log(`  calls: POST ${url}  (JSON-RPC, method "SendMessage")`);
    if (!isLoopback(cmd.host)) {
      console.log('');
      console.log(`  WARNING: ${cmd.host} is reachable from outside this machine, and this server has no`);
      console.log('  authentication. Anything that can reach it can ask Tewip to read this repository.');
      console.log('  Only the read-only skills are exposed - nothing here writes a file - but a port');
      console.log('  that reads your source to strangers is still a port that reads your source.');
    }
    console.log('');
    console.log('Every request is recorded in .tewip/a2a.jsonl. Stop with Ctrl+C.');
  });
  return server;
}
