// What an AI agent is allowed to do, read from its source before it ever runs.
//
// Every tool in this market evaluates an agent by running it: Langfuse, Phoenix, RAGAS, TruLens,
// DeepEval, Promptfoo, Giskard, garak. They need a runtime, a token budget and usually an account,
// and most judge with another model, so the same agent scores differently on Tuesday. They answer
// "is this agent any good".
//
// Nobody answers the question an IT department actually has to sign off on: **what is this agent
// allowed to do, and what stands between it and the real world?** That one is decidable by
// reading, for free, offline, in CI, before anything runs. It is also the question an auditor
// asks, and the one a post-mortem starts from.
//
// The honesty rule is the same as everywhere else in Tewip. A tool whose reach cannot be decided
// from its name and description is reported as undecided, never as safe. "No approval gate found"
// is a fact about this source, not a verdict about the running system, and the report says which
// it is.
import { blank, type Blanked } from './source-text.ts';

const NL = String.fromCharCode(10);

// `destructive` is the author's own word, not a guess: an MCP tool that declares
// `destructiveHint: true` is saying this cannot be undone. Kept apart from `deletes` because
// `write_file` overwrites rather than deletes, and reporting it as a deletion would be putting a
// word in somebody's mouth that their own description does not use.
export type Reach = 'destructive' | 'deletes' | 'pays' | 'sends' | 'runs-code' | 'writes' | 'reads' | 'not-sure';

export interface AgentTool {
  /** The tool name the model sees. */
  name: string;
  file: string;
  line: number;
  /** The framework shape that matched, so a reader can check the finding. */
  shape: string;
  /** The description written beside it, which is also what the model is steered by. */
  description: string;
  reach: Reach;
  /** The word that decided the reach, so the classification is checkable. */
  why: string;
  /** Which legs of the lethal trifecta this tool supplies. */
  capabilities: Capability[];
}

/**
 * How a tool is declared, per framework.
 *
 * Listed by framework rather than guessed at, for the same reason the assertion vocabulary is: a
 * shape that is missing produces silence, and silence here reads as "this agent has no tools",
 * which is the worst possible wrong answer. So the report names which frameworks were looked for
 * and says plainly that anything else was not seen.
 */
interface Shape {
  framework: string;
  /** Group 1 must be the tool name. */
  re: RegExp;
}

const PYTHON_SHAPES: Shape[] = [
  // LangChain / LangGraph: @tool("name") or a bare @tool above the function that names it.
  { framework: 'LangChain @tool', re: /@tool\s*\(\s*["']([\w.-]+)["']/g },
  { framework: 'LangChain @tool', re: /@tool(?:\s*\(\s*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g },
  // MCP Python SDK, and FastMCP.
  { framework: 'MCP @tool', re: /@(?:mcp|server|app)\.tool\s*\(\s*(?:\)\s*)?\n\s*(?:async\s+)?def\s+(\w+)/g },
  { framework: 'MCP @tool', re: /@(?:mcp|server|app)\.tool\s*\(\s*name\s*=\s*["']([\w.-]+)["']/g },
  // OpenAI Agents SDK.
  { framework: 'OpenAI @function_tool', re: /@function_tool(?:\s*\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g },
  // Explicit construction, LangChain and CrewAI alike.
  { framework: 'Tool(name=...)', re: /\b(?:Structured)?Tool\s*\(\s*name\s*=\s*["']([\w.\s-]+)["']/g },
];

const JS_SHAPES: Shape[] = [
  // MCP TypeScript SDK.
  { framework: 'MCP server.tool()', re: /\b(?:server|mcp|app)\s*\.\s*(?:tool|registerTool)\s*\(\s*["']([\w.-]+)["']/g },
  // Vercel AI SDK: tools: { theName: tool({ ... }) }
  { framework: 'AI SDK tool()', re: /\b([\w.-]+)\s*:\s*tool\s*\(\s*\{/g },
  // Anthropic's own tool shape, and anything else that writes a JSON schema by hand.
  { framework: 'name + input_schema', re: /name\s*:\s*["']([\w.-]+)["'][^}]{0,400}?input_schema\s*:/g },
  // OpenAI function calling.
  { framework: 'OpenAI function', re: /type\s*:\s*["']function["'][^}]{0,200}?name\s*:\s*["']([\w.-]+)["']/g },
  // LangChain JS.
  { framework: 'DynamicStructuredTool', re: /new\s+Dynamic(?:Structured)?Tool\s*\(\s*\{[^}]{0,200}?name\s*:\s*["']([\w.-]+)["']/g },
];

/**
 * What the tool does to the world, from its name and its description.
 *
 * Ordered most-serious first on purpose: `delete_and_notify` is a delete, not a send. A name that
 * matches nothing is `not-sure`, which is printed as undecided - never folded into "reads", because
 * the whole value of this report is that it does not quietly downgrade a risk it failed to parse.
 */
/**
 * `ENDING` matters more than the word lists do.
 *
 * Without it these were written `\b(?:read|...)\b`, and `\bread\b` does not match "Reads" - the
 * trailing s removes the word boundary. Tool names survive that, because `read_file` splits on the
 * underscore, but descriptions do not: they are written in the third person. "Reads test files and
 * says..." matched nothing, and all seventeen tools in Tewip's own MCP server came back undecided
 * while the file sat there saying exactly what each one did.
 */
const ENDING = String.raw`(?:e?[sd]|ing)?\b`;
const verbs = (words: string) => new RegExp(String.raw`\b(?:${words})${ENDING}`, 'i');

const REACH: Array<{ reach: Reach; words: RegExp }> = [
  { reach: 'deletes', words: verbs('delete|destroy|drop|purge|wipe|remove|revoke|terminate|uninstall|erase|truncate') },
  { reach: 'pays', words: verbs('pay|payment|refund|charge|transfer|invoice|payout|purchase|checkout|billing|subscribe|withdraw') },
  { reach: 'runs-code', words: verbs('exec|execute|shell|bash|terminal|subprocess|run_code|runcode|eval|interpreter|command') },
  { reach: 'sends', words: verbs('send|email|mail|post|publish|notify|notification|sms|slack|tweet|broadcast|message|dispatch|share|invite') },
  { reach: 'writes', words: verbs('write|create|update|insert|upsert|upload|save|edit|modify|patch|rename|commit|merge|deploy|provision|grant') },
  { reach: 'reads', words: verbs('get|list|read|search|fetch|find|query|lookup|show|describe|view|count|check|status|say|report|explain|answer|tell|trace|plan|prove|recall') },
];

/** Everything that cannot be taken back once the model has called it. */
export const IRREVERSIBLE: ReadonlyArray<Reach> = ['destructive', 'deletes', 'pays', 'sends', 'runs-code'];

/**
 * The three capabilities that are survivable alone and catastrophic together.
 *
 * Untrusted input and private data and a way to send data out, in one loop: text the agent did not
 * write tells it to read the secrets and post them somewhere, and every step of that is a tool the
 * agent was legitimately given. No prompt is clever enough to be relied on as the only thing
 * standing in the way, because the attacker gets to write the other half of the prompt.
 *
 * This is the one property in agent safety that is genuinely decidable by reading the tool list,
 * and it is why this file classifies capability separately from reach. A tool can be harmless by
 * itself - `fetch_url` reverses nothing, `read_file` deletes nothing - and still be one leg of
 * this. Counting only irreversibility would call all three of them safe.
 */
export type Capability = 'untrusted-input' | 'private-data' | 'can-send-out';

export const CAPABILITY_MEANS: Record<Capability, string> = {
  'untrusted-input': 'pulls in text somebody outside your company can write',
  'private-data': 'reads data that is not meant to leave',
  'can-send-out': 'can put data somewhere outside',
};

const CAPABILITIES: Array<{ capability: Capability; words: RegExp }> = [
  {
    capability: 'untrusted-input',
    words: /\b(?:fetch|browse|scrape|crawl|web|url|http|search|google|bing|read_email|readmail|inbox|gmail|ticket|issue|comment|review|pdf|document|attachment|rss|feed|webhook_in|transcri)\w*/i,
  },
  {
    capability: 'private-data',
    words: /\b(?:sql|query|database|db|select|table|record|customer|user|account|employee|salary|patient|secret|credential|token|key|env|vault|file|read_file|readfile|fs|s3|bucket|storage|internal|crm|ledger)\w*/i,
  },
  {
    capability: 'can-send-out',
    words: /\b(?:send|email|mail|smtp|post|publish|webhook|slack|discord|teams|sms|twilio|tweet|upload|push|notify|share|export|forward|broadcast|comment|reply)\w*/i,
  },
];

export function capabilitiesOf(name: string, description: string): Capability[] {
  const text = `${name.replace(/[_-]/g, ' ')} ${description}`;
  return CAPABILITIES.filter(({ words }) => words.test(text)).map(({ capability }) => capability);
}

export interface Trifecta {
  complete: boolean;
  /** The tools giving each leg, so the claim can be checked rather than believed. */
  legs: Record<Capability, AgentTool[]>;
}

export function trifectaIn(tools: AgentTool[]): Trifecta {
  const legs: Record<Capability, AgentTool[]> = { 'untrusted-input': [], 'private-data': [], 'can-send-out': [] };
  for (const tool of tools) for (const c of tool.capabilities) legs[c].push(tool);
  return { complete: Object.values(legs).every((l) => l.length > 0), legs };
}

/**
 * What the author declared, which beats anything guessed from a name.
 *
 * MCP tools carry `readOnlyHint` and `destructiveHint`, and a tool that says of itself that it is
 * read-only is better evidence than any verb list. Both shapes are read: written inline, and
 * written once as a named constant and reused - `annotations: readOnly`, with
 * `const readOnly = { readOnlyHint: true, ... }` further up the same file, which is how Tewip's own
 * server does it and therefore the shape most likely to be missed by a check written against the
 * documentation instead of against real code.
 */
function declaredHint(text: string, from: number): { reach: Reach; why: string } | null {
  const window = text.slice(from, from + 1200);
  const named = /annotations\s*:\s*([A-Za-z_$][\w$]*)/.exec(window);
  const where = named
    ? new RegExp(String.raw`\b(?:const|let|var)\s+${named[1]}\s*(?::[^=]{0,120})?=\s*\{([^}]{0,300})\}`).exec(text)?.[1] ?? ''
    : window;
  if (/destructiveHint\s*:\s*true/.test(where)) return { reach: 'destructive', why: 'its own annotation says destructiveHint: true' };
  if (/readOnlyHint\s*:\s*true/.test(where)) return { reach: 'reads', why: 'it declares readOnlyHint: true' };
  return null;
}

export function reachOf(name: string, description: string): { reach: Reach; why: string } {
  // The name first. A description is marketing for the model and often says "safely" about a tool
  // that drops a table; the name is what the person who wrote it called the thing.
  for (const { reach, words } of REACH) {
    const hit = words.exec(name.replace(/[_-]/g, ' '));
    if (hit) return { reach, why: `its name contains "${hit[0]}"` };
  }
  // Only the opening clause of the description, where a tool says what it does: "Reads test files
  // and says...". Searching the whole of it matches verbs in prose that are about something else
  // entirely - Tewip's own `explain_failure` describes "history on this commit versus others" and
  // was classified as a tool that writes, on the strength of the word "commit" in a sentence about
  // reading. A first clause is a claim about the tool; the rest is explanation.
  const opening = description.split(/[.;:]/)[0]?.slice(0, 120) ?? '';
  for (const { reach, words } of REACH) {
    const hit = words.exec(opening);
    if (hit) return { reach, why: `its description opens with "${hit[0]}"` };
  }
  return { reach: 'not-sure', why: 'neither its name nor its description says what it does to the world' };
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split(NL).length;


/** The description written beside a tool, when one is written at all. */
function describedNear(text: string, from: number): string {
  const window = text.slice(from, from + 600);
  const described =
    // Up to 800: a real tool description is a paragraph, not a label. Capped at 200 this matched
    // none of the seventeen in Tewip's own MCP server, so every one of them came back undecided.
    /description\s*[:=]\s*["'`]((?:[^"'`\\]|\\.){3,800})["'`]/.exec(window) ??
    // A Python docstring on the line after the def is the description the framework sends.
    /def\s+\w+[^\n]*\n\s*(?:"""|''')\s*([^\n"']{3,200})/.exec(window);
  return (described?.[1] ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * `blanked` is the caller's copy of the scan, because `blank` already computes both answers in one
 * pass and `guardsIn` needs the other one. Computed separately in each, the same file was scanned
 * twice - twelve seconds of duplicate work on a twenty-thousand-file project.
 */
export function toolsIn(file: string, text: string, blanked?: Blanked): AgentTool[] {
  const python = /\.py$/i.test(file);
  const source = (blanked ?? blank(text, python)).code;
  const found = new Map<string, AgentTool>();
  for (const { framework, re } of python ? PYTHON_SHAPES : JS_SHAPES) {
    for (const m of source.matchAll(re)) {
      const name = m[1]?.trim();
      if (!name || name.length > 60) continue;
      const line = lineOf(source, m.index ?? 0);
      // One entry per name per file: the same tool matched by two shapes is one tool.
      const key = `${name}:${file}`;
      if (found.has(key)) continue;
      // The original text, not the blanked one: a Python docstring *is* the description, and it
      // has just been blanked for matching. The indexes line up because blanking kept the lengths.
      const description = describedNear(text, m.index ?? 0);
      // Declared first, guessed second.
      const { reach, why } = declaredHint(source, m.index ?? 0) ?? reachOf(name, description);
      found.set(key, { name, file, line, shape: framework, description, reach, why, capabilities: capabilitiesOf(name, description) });
    }
  }
  return [...found.values()];
}

/** The frameworks this knows how to read, named in the report so the silence is not mistaken. */
export const FRAMEWORKS_READ = [
  'LangChain and LangGraph (`@tool`, `Tool(name=...)`, `DynamicStructuredTool`)',
  'the MCP SDKs, Python and TypeScript (`@mcp.tool`, `server.tool(...)`)',
  'the OpenAI Agents SDK (`@function_tool`) and OpenAI function calling',
  'the Vercel AI SDK (`tool({ ... })`)',
  "Anthropic's tool shape (`name` beside `input_schema`)",
];
