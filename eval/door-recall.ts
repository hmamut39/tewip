// OWASP ASI07, measured: an agent interface bound beyond the machine it runs on.
//
// A conjunction, so the decoys matter more than usual. An agent interface on its own is how every
// multi-agent system is built; a bind to `0.0.0.0` on its own is how everything in a container
// runs. Either alone must stay silent, or this check reports a door in every repository that has a
// web server or a tool definition - which is most of them.
//
// The shapes are the protocols' own: A2A's well-known agent card and its v1.0 `SendMessage`, and
// the two HTTP transports the MCP SDK exports. Verified against the installed SDK rather than
// remembered - `SSEServerTransport` and `StreamableHTTPServerTransport` are the class names in
// node_modules/@modelcontextprotocol/sdk.
//
// Run: node eval/door-recall.ts
import { agentDoors } from '../engine/agent/agent-door.ts';

const NL = String.fromCharCode(10);

interface Case {
  what: string;
  /** Where the shape comes from, so the ground truth is somebody else's. */
  source: string;
  file: string;
  body: string;
  /** For a decoy: why reporting it would be wrong. */
  why?: string;
}

const CASES: Case[] = [
  {
    what: 'MCP over SSE, every interface',
    source: '@modelcontextprotocol/sdk — SSEServerTransport',
    file: 'mcp_sse.ts',
    body: ['const transport = new SSEServerTransport("/messages", res);', 'await server.connect(transport);', 'app.listen(3000, "0.0.0.0");'].join(NL),
  },
  {
    what: 'MCP over streamable HTTP',
    source: '@modelcontextprotocol/sdk — StreamableHTTPServerTransport',
    file: 'mcp_http.ts',
    body: ['const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });', 'app.listen({ host: "0.0.0.0", port: 8080 });'].join(NL),
  },
  {
    what: 'an A2A agent card served to every interface',
    source: 'the A2A well-known path, the one Tewip serves itself',
    file: 'a2a_card.ts',
    body: ['app.get("/.well-known/agent-card.json", (req, res) => res.json(card));', 'app.listen(9000, "0.0.0.0");'].join(NL),
  },
  {
    what: 'an A2A server in Python',
    source: 'A2A v1.0 SendMessage, served with uvicorn',
    file: 'a2a_py.py',
    body: ['def SendMessage(request):', '    return handle(request)', '', 'uvicorn.run(app, host="0.0.0.0", port=8000)'].join(NL),
  },
  {
    what: 'bound to every interface by IPv6',
    source: '`::` is every interface too, and is how Node writes it when nobody passes a host',
    file: 'v6.ts',
    body: ['const transport = new StreamableHTTPServerTransport({});', 'server.listen(7000, "::");'].join(NL),
  },
];

const DECOYS: Case[] = [
  {
    what: 'an agent server on loopback',
    source: 'what Tewip’s own A2A server does, on purpose',
    file: 'local.ts',
    body: ['const transport = new SSEServerTransport("/messages", res);', 'app.listen(3000, "127.0.0.1");'].join(NL),
    why: 'loopback is the safe answer and the shape that gets this right. Reporting it would turn the correct choice into a finding',
  },
  {
    what: 'an ordinary web server on every interface',
    source: 'how everything in a container is started',
    file: 'web.ts',
    body: ['app.get("/health", (req, res) => res.send("ok"));', 'app.listen(3000, "0.0.0.0");'].join(NL),
    why: 'there is no agent protocol here. A bind alone is how every container runs, and counting it would report a door in most repositories',
  },
  {
    what: 'an agent interface with no bind in the file',
    source: 'a transport wired up where the server is started elsewhere',
    file: 'wire.ts',
    body: ['export const transport = new SSEServerTransport("/messages", res);'].join(NL),
    why: 'the door is here and the street is not. Guessing at the bind in another file is the cross-file inference this project refuses everywhere else',
  },
  {
    what: 'fetching somebody else’s agent card',
    source: 'being a client rather than a server',
    file: 'client.ts',
    body: ['const card = await fetch(peer + "/.well-known/agent-card.json").then((r) => r.json());', 'app.listen(3000, "0.0.0.0");'].join(NL),
    why: 'reading another agent’s card is not serving one. This one is the honest limit: the path is identical either way, and the bind beside it is a different server',
  },
  {
    what: 'the warning written as a comment',
    source: 'Tewip’s own serve.ts, which says in a comment that binding to 0.0.0.0 would be worse than any bug it found',
    file: 'warned.ts',
    body: ['// A quality tool that quietly opened a port on 0.0.0.0 would be a worse problem than any bug.', 'const transport = new SSEServerTransport("/messages", res);', 'app.listen(3000, "127.0.0.1");'].join(NL),
    why: 'a bind written in a comment binds nothing. Found by running this check over Tewip itself, where that sentence is on line 7',
  },
];

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

export interface Measured {
  what: string;
  found: boolean;
}

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { doors: Measured[]; decoys: Measured[] } {
  return {
    doors: CASES.map((c) => ({ what: c.what, found: agentDoors(c.file, c.body).length > 0 })),
    decoys: DECOYS.map((d) => ({ what: d.what, found: agentDoors(d.file, d.body).length > 0 })),
  };
}

function report(): void {
  const { doors, decoys } = measure();
  const found = doors.filter((d) => d.found);
  const invented = decoys.filter((d) => d.found);
  const lines = [
    '# an agent interface somebody else can reach (OWASP ASI07), measured',
    '',
    `${CASES.length} doors on the street, written the way the protocols write them, and`,
    `${DECOYS.length} decoys that look like one and are not.`,
    '',
    `Doors found:            ${found.length} of ${CASES.length} (${pct(found.length, CASES.length)})`,
    `Invented from a decoy:  ${invented.length} of ${DECOYS.length}`,
    '',
  ];
  const missed = doors.filter((d) => !d.found);
  if (missed.length > 0) {
    lines.push('## Doors it cannot see', '', ...missed.map((d) => `- **${d.what}**`), '');
  }
  lines.push('## Invented', '', invented.length === 0 ? 'None of them was counted as a door.' : invented.map((d) => `- **${d.what}**`).join(NL), '');
  lines.push(
    '---',
    '',
    'Three of the five decoys are the conjunction doing its work: an interface alone, a bind alone,',
    'and a client rather than a server. The fourth is loopback, which is the right answer and must',
    'never be reported. The fifth is a bind written in a comment, which is where Tewip’s own',
    'warning about binding to every interface happens to live.',
    '',
    'What this cannot say is whether anything in front of the port checks a caller. That is an',
    'ingress, a mesh or a security group, none of which is in the source, and the report says so',
    'rather than implying a verdict it has not earned.',
    '',
  );
  process.stdout.write(lines.join(NL));
  if (invented.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
