// OWASP ASI04, measured: where an agent's tool servers come from.
//
// OWASP cites one case for this risk by name, and it is the whole argument for the check. A package
// impersonating `postmark-mcp` sat on npm through a run of clean versions and then, in 1.0.16, began
// adding a hidden BCC of every email it sent to an address its author controlled. No configuration
// changed; `npx -y postmark-mcp` fetches whatever is newest at every start.
//
// Every case below is the invocation a real MCP server documents in its own README or its registry
// entry - which is the ground truth that matters here, because those lines are what people paste
// into a config file. The decoys are the pinned forms of the same thing, plus the shapes that are
// not a fetch at all: a server built in this repository, and a remote URL where pinning is not the
// control.
//
// Run: node eval/supply-recall.ts
import { sourceOf } from '../engine/agent/server-pinning.ts';

const NL = String.fromCharCode(10);

interface Case {
  name: string;
  command: string;
  args: string;
  url?: string;
  /** Whether the code behind this server can change between one start-up and the next. */
  moves: boolean;
  why: string;
}

const CASES: Case[] = [
  // ---- what people actually paste in ----
  {
    name: 'the filesystem server, as its README gives it',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem /path/to/dir',
    moves: true,
    why: 'no version, and -y answers the one prompt that would have asked a person',
  },
  {
    name: 'a server pulled with uvx, as the Python ones document',
    command: 'uvx',
    args: 'mcp-server-git --repository .',
    moves: true,
    why: 'uvx resolves the newest release at every start',
  },
  {
    name: 'the shape OWASP cites: an impersonating npm package',
    command: 'npx',
    args: '-y postmark-mcp',
    moves: true,
    why: 'clean for several versions, then 1.0.16 added a hidden BCC to its author',
  },
  {
    name: 'pinned to a tag that moves',
    command: 'npx',
    args: '-y @some/mcp-server@latest',
    moves: true,
    why: '`latest` is the default wearing a version’s clothes',
  },
  {
    name: 'a container with no tag',
    command: 'docker',
    args: 'run -i --rm mcp/github-mcp-server',
    moves: true,
    why: 'no tag is `:latest`, resolved again on every pull',
  },
  {
    name: 'a container on a moving tag',
    command: 'docker',
    args: 'run -i --rm ghcr.io/example/mcp:main',
    moves: true,
    why: '`main` is a branch, and a branch is not a version',
  },
  {
    name: 'pipx run, the other Python runner',
    command: 'pipx',
    args: 'run some-mcp-server',
    moves: true,
    why: 'the same fetch with a different name on it',
  },
  // ---- the pinned and local forms, which must stay quiet ----
  {
    name: 'DECOY: the same npm server, pinned',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem@2026.9.1 /path/to/dir',
    moves: false,
    why: 'a new release does not change what the agent runs',
  },
  {
    name: 'DECOY: a scoped package pinned, where the scope also uses an @',
    command: 'npx',
    args: '-y @scope/pkg@0.3.14',
    moves: false,
    why: 'the leading @ is the scope; the version separator is the one after a name character',
  },
  {
    name: 'DECOY: a Python server pinned the Python way',
    command: 'uvx',
    args: 'mcp-server-git==0.6.2 --repository .',
    moves: false,
    why: '== is how a Python version is pinned',
  },
  {
    name: 'DECOY: a container pinned by digest',
    command: 'docker',
    args: 'run -i --rm mcp/github-mcp-server@sha256:3f8c1d9a0b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f01',
    moves: false,
    why: 'a digest is the strongest of the three pins',
  },
  {
    name: 'DECOY: a server built in this repository',
    command: 'node',
    args: './dist/mcp/server.js',
    moves: false,
    why: 'the code is here and is reviewed the way the rest of it is',
  },
  {
    name: 'DECOY: a Python server run from this repository',
    command: 'python3',
    args: '-m myproject.mcp',
    moves: false,
    why: 'the same thing in the other language',
  },
  {
    name: 'DECOY: a remote server, where pinning is not the control',
    command: '',
    args: '',
    url: 'https://mcp.example.com/sse',
    moves: false,
    why: 'nothing is fetched; whoever answers that address decides what the tools do, and the question is who that is',
  },
];

export interface Measured { name: string; found: boolean }

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { flows: Measured[]; decoys: Measured[] } {
  const ran = (c: Case) => ({ name: c.name, found: sourceOf(c.name, c.command, c.args, c.url ?? '').how === 'fetched at every start' });
  return {
    flows: CASES.filter((c) => c.moves).map(ran),
    decoys: CASES.filter((c) => !c.moves).map(ran),
  };
}

function report(): void {
  const { flows, decoys } = measure();
  const found = flows.filter((f) => f.found).length;
  const accused = decoys.filter((d) => d.found).length;
  const lines = [
    '# where an agent’s tool servers come from (OWASP ASI04), measured',
    '',
    `${found} of ${flows.length} unpinned invocations read, and ${accused} of ${decoys.length} pinned or local ones accused.`,
    '',
    'Each case is the invocation a real MCP server documents in its own README or registry entry, because those lines are',
    'what people paste into a config file.',
    '',
    '| case | can it change under you? | read as | |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of CASES) {
    const got = sourceOf(c.name, c.command, c.args, c.url ?? '');
    const ok = c.moves === (got.how === 'fetched at every start');
    lines.push(`| ${c.name} | ${c.moves ? 'yes' : 'no'} | ${got.how}${got.pin ? ` (${got.pin})` : ''} | ${ok ? 'ok' : '**wrong**'} |`);
  }
  lines.push(
    '',
    'A lockfile does not cover any of this. These servers are not dependencies of the project - they are fetched by the',
    'agent harness at run time, from a name whoever can publish to it controls. OWASP names pinning, by version or by',
    'content hash, as the control, and that is a property of the line rather than an inference about behaviour.',
    '',
  );
  process.stdout.write(lines.join(NL));
}

if (import.meta.main) report();
