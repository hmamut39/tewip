// How much `tewip agent` finds, measured against each framework's own documentation.
//
// `agent` has been measured on real projects - the official MCP servers, the OpenAI Agents SDK,
// CrewAI, Tewip's own server - and that says what it reports on code people wrote. It cannot say
// what it walks past, because a shape nobody in the corpus uses is a shape nobody measures.
//
// The ground truth here is **the way each framework's own documentation declares a tool**. Every
// case below is the shape its quickstart shows, written as a file a team would commit, and
// labelled with the framework rather than with anything in `tools.ts`. A miss is a framework whose
// documented shape Tewip cannot read, which is the thing that matters: silence about a framework
// reads as "this agent has no tools", and that is the worst wrong answer this command has.
//
// Decoys are planted beside them: the same words in prose, in a comment, in a docstring and in a
// test file. The phase that built this found all four kinds reported as real tools on real
// repositories, so they are measured rather than assumed.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAgent } from '../engine/agent/scan.ts';

const NL = String.fromCharCode(10);

interface Case {
  framework: string;
  file: string;
  /** The tool name the file declares, which is what should come back. */
  tool: string;
  body: string;
}

const CASES: Case[] = [
  {
    framework: 'MCP, TypeScript SDK',
    file: 'src/mcp-ts.ts',
    tool: 'delete_record',
    body: `server.registerTool("delete_record", { description: "Deletes a record.", annotations: { destructiveHint: true } }, handler);`,
  },
  {
    framework: 'MCP, Python SDK',
    file: 'src/mcp_py.py',
    tool: 'purge_cache',
    body: ['@mcp.tool()', 'async def purge_cache(key: str) -> str:', '    """Purges the cache."""', '    return key'].join(NL),
  },
  {
    framework: 'LangChain, @tool decorator',
    file: 'src/langchain_tool.py',
    tool: 'send_invoice',
    body: ['@tool', 'def send_invoice(to: str) -> str:', '    """Sends an invoice by email."""', '    return to'].join(NL),
  },
  {
    framework: 'LangChain, @tool with a name',
    file: 'src/langchain_named.py',
    tool: 'refund_order',
    body: ['@tool("refund_order")', 'def _refund(order_id: str) -> str:', '    """Refunds an order."""', '    return order_id'].join(NL),
  },
  {
    framework: 'LangChain JS, DynamicStructuredTool',
    file: 'src/langchain_js.ts',
    tool: 'drop_table',
    body: `const t = new DynamicStructuredTool({ name: "drop_table", description: "Drops a table.", func: run });`,
  },
  {
    framework: 'OpenAI Agents SDK, @function_tool',
    file: 'src/openai_agents.py',
    tool: 'transfer_funds',
    body: ['@function_tool', 'def transfer_funds(amount: int) -> str:', '    """Transfers funds between accounts."""', '    return "ok"'].join(NL),
  },
  {
    framework: 'OpenAI function calling',
    file: 'src/openai_functions.ts',
    tool: 'charge_card',
    body: `const tools = [{ type: "function", function: { name: "charge_card", description: "Charges a card." } }];`,
  },
  {
    framework: 'Anthropic tool shape',
    file: 'src/anthropic.ts',
    tool: 'read_file',
    body: `const tools = [{ name: "read_file", description: "Reads a file.", input_schema: { type: "object" } }];`,
  },
  {
    framework: 'Vercel AI SDK',
    file: 'src/ai_sdk.ts',
    tool: 'publish_post',
    body: `export const tools = { publish_post: tool({ description: "Publishes a post.", execute: run }) };`,
  },
  {
    framework: 'CrewAI / LangChain, Tool(name=...)',
    file: 'src/crew.py',
    tool: 'wipe_index',
    body: ['from crewai_tools import Tool', '', 'wipe = Tool(name="wipe_index", description="Wipes the search index.", func=run)'].join(NL),
  },
];

/** Shapes that mention a tool and declare none. All four were found on real repositories. */
const DECOYS: Case[] = [
  { framework: 'a docstring example', file: 'src/doc_example.py', tool: 'greet', body: ['def tool(*args):', '    """Decorator to create a Tool.', '', '    Example:', '        @tool', '        def greet(name: str) -> str:', '            return name', '    """', '    pass'].join(NL) },
  { framework: 'a commented-out tool', file: 'src/commented.ts', tool: 'old_delete', body: `// server.registerTool("old_delete", { description: "Deletes." });`, },
  { framework: 'a JSDoc block', file: 'src/jsdoc.ts', tool: 'sample_tool', body: ['/**', ' * Usage:', ' *   server.registerTool("sample_tool", { description: "x" });', ' */', 'export const nothing = 1;'].join(NL) },
  { framework: 'a test fixture', file: 'integration_tests/helpers.py', tool: 'fake_delete', body: ['@tool', 'def fake_delete():', '    """A double for tests."""', '    pass'].join(NL) },
];

export interface Measured {
  framework: string;
  tool: string;
  found: boolean;
}

export function measure(): { frameworks: Measured[]; decoys: Measured[] } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-agent-recall-'));
  try {
    for (const c of [...CASES, ...DECOYS]) {
      mkdirSync(join(root, c.file, '..'), { recursive: true });
      writeFileSync(join(root, c.file), c.body, 'utf8');
    }
    const names = new Set(scanAgent(root).tools.map((t) => t.name));
    const judge = (c: Case): Measured => ({ framework: c.framework, tool: c.tool, found: names.has(c.tool) });
    return { frameworks: CASES.map(judge), decoys: DECOYS.map(judge) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function report(): void {
  const { frameworks, decoys } = measure();
  const found = frameworks.filter((f) => f.found);
  const invented = decoys.filter((d) => d.found);
  const pct = (n: number) => `${((n / frameworks.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      "# agent, measured against each framework's own documentation",
      '',
      `${frameworks.length} tool declarations, each written the way its framework's quickstart writes it, planted`,
      'together in one project and labelled by framework rather than by anything in tools.ts.',
      '',
      `Tools found:            ${found.length} of ${frameworks.length} (${pct(found.length)})`,
      `Invented from a decoy:  ${invented.length} of ${decoys.length}`,
      '',
      '## Frameworks whose documented shape it cannot read',
      '',
      ...(frameworks.filter((f) => !f.found).length === 0
        ? ['None.']
        : frameworks.filter((f) => !f.found).map((f) => `- **${f.framework}** — declares \`${f.tool}\`, which did not come back`)),
      '',
      '## Tools it invented',
      '',
      'Four shapes that mention a tool and declare none: an example inside a docstring, a commented',
      'out registration, a usage block in JSDoc, and a fixture in a test folder. All four were found',
      'being reported as real tools on real repositories while this command was being built.',
      '',
      ...(invented.length === 0 ? ['None of them was reported as a tool.'] : invented.map((d) => `- **${d.framework}** — reported \`${d.tool}\``)),
      '',
      '---',
      '',
      'A miss here is the thing that matters most: silence about a framework reads as "this agent has',
      'no tools", and the report says which shapes it looked for so that silence can be read',
      'correctly. What no planting can settle is a tool assembled at run time from a registry or a',
      'plugin folder, which is named in the report as not checked.',
      '',
    ].join(NL),
  );
}

if (process.argv[1]?.includes('agent-recall')) report();
