// What stands between an agent's tools and the real world - measured, because the claim is a
// negative one and nobody had ever checked it.
//
// `agent` reports three things. The tools have a number (eval/agent-recall.ts) and the injection
// flows have one (eval/injection-recall.ts). The guards had none, and were not even listed as
// unmeasured, while the pack printed this about them:
//
//   **Nothing anywhere in this project asks a person anything, declares a step ceiling, or draws
//   its tools from a named list.** Where a tool can delete or pay, that is not a maybe.
//
// That is categorical, and it is an *absence* claim - the hardest kind to earn and the easiest to
// get wrong, because a shape the reader cannot parse produces exactly the same silence as a shape
// that is not there. If `guardsIn` cannot read a framework's gate, the pack tells an IT department
// that an agent which stops and asks does no such thing, in bold, and invites them to act on it.
//
// Every case below is the shape the framework's own documentation uses, with the page that shows it
// named beside it. Where a framework documents a Python form and a JavaScript form, both are here:
// the two are different strings and a reader that only knows one is silent about half the market.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAgent } from '../engine/agent/scan.ts';
import type { GuardKind } from '../engine/agent/guards.ts';

const NL = String.fromCharCode(10);

interface Case {
  framework: string;
  /** Where the shape is published, so the ground truth is somebody else's. */
  source: string;
  kind: GuardKind;
  file: string;
  body: string;
  /** For a decoy: why counting it as a guard would be wrong. */
  why?: string;
}

const CASES: Case[] = [
  {
    framework: 'LangGraph, Python',
    source: 'langchain-ai.github.io/langgraph human-in-the-loop',
    kind: 'asks-a-person',
    file: 'graph_py.py',
    body: ['from langgraph.types import interrupt', '', 'def review(state):', '    answer = interrupt({"question": "ship it?"})', '    return {"ok": answer}'].join(NL),
  },
  {
    framework: 'LangGraph, Python, compiled gate',
    source: 'langchain-ai.github.io/langgraph human-in-the-loop',
    kind: 'asks-a-person',
    file: 'compile_py.py',
    body: 'graph = workflow.compile(checkpointer=saver, interrupt_before=["tools"])',
  },
  {
    framework: 'LangGraph, JavaScript, compiled gate',
    source: 'docs.langchain.com/oss/javascript/langgraph/add-human-in-the-loop',
    kind: 'asks-a-person',
    file: 'compile_js.ts',
    body: 'const graph = workflow.compile({ checkpointer, interruptBefore: ["tools"] });',
  },
  {
    framework: 'LangGraph, JavaScript, inside a node',
    source: 'docs.langchain.com/oss/javascript/langgraph/interrupts',
    kind: 'asks-a-person',
    file: 'node_js.ts',
    body: ['export async function review(state: State) {', '  const answer = interrupt({ question: "ship it?" });', '  return { ok: answer };', '}'].join(NL),
  },
  {
    framework: 'OpenAI Agents SDK, Python',
    source: 'openai.github.io/openai-agents-python/human_in_the_loop',
    kind: 'asks-a-person',
    file: 'approve_py.py',
    body: ['@function_tool(needs_approval=True)', 'def refund(order_id: str) -> str:', '    return charge.refund(order_id)'].join(NL),
  },
  {
    framework: 'OpenAI Agents SDK, JavaScript',
    source: 'openai.github.io/openai-agents-js/guides/human-in-the-loop',
    kind: 'asks-a-person',
    file: 'approve_js.ts',
    body: ['export const cancelOrder = tool({', '  name: "cancel_order",', '  needsApproval: true,', '  execute: async ({ id }) => api.cancel(id),', '});'].join(NL),
  },
  {
    framework: 'CrewAI',
    source: 'docs.crewai.com/en/learn/human-input-on-execution',
    kind: 'asks-a-person',
    file: 'crew.py',
    body: ['writer_task = Task(', '    description="Write the post.",', '    agent=writer,', '    human_input=True,', ')'].join(NL),
  },
  {
    framework: 'LangChain, approval callback',
    source: 'python.langchain.com human approval callback',
    kind: 'asks-a-person',
    file: 'callback.py',
    body: ['from langchain.callbacks import HumanApprovalCallbackHandler', '', 'chain.run(query, callbacks=[HumanApprovalCallbackHandler()])'].join(NL),
  },
  {
    framework: 'LangGraph, recursion ceiling',
    source: 'langchain-ai.github.io/langgraph recursion limit',
    kind: 'step-budget',
    file: 'limit_py.py',
    body: 'result = graph.invoke(state, config={"recursion_limit": 25})',
  },
  {
    framework: 'OpenAI Agents SDK, turn ceiling',
    source: 'openai.github.io/openai-agents-js running agents',
    kind: 'step-budget',
    file: 'turns_js.ts',
    body: 'const result = await run(agent, input, { maxTurns: 10 });',
  },
  {
    framework: 'Vercel AI SDK, step ceiling',
    source: 'ai-sdk.dev/docs/agents/loop-control',
    kind: 'step-budget',
    file: 'loop_js.ts',
    body: ['const result = await generateText({', '  model,', '  tools,', '  stopWhen: stepCountIs(5),', '});'].join(NL),
  },
  {
    framework: 'LangChain, iteration ceiling',
    source: 'python.langchain.com agent executor',
    kind: 'step-budget',
    file: 'iters.py',
    body: 'executor = AgentExecutor(agent=agent, tools=tools, max_iterations=6)',
  },
  {
    framework: 'an allow-list, as every agent runtime writes one',
    source: "Claude Code settings.json and LangChain's allowed_tools",
    kind: 'tool-allow-list',
    file: 'allow.py',
    body: 'agent = initialize_agent(tools, llm, allowed_tools=["search", "read_file"])',
  },
  {
    framework: 'a dry run',
    source: 'the flag every deployment tool publishes',
    kind: 'dry-run',
    file: 'apply.py',
    body: 'def apply(plan, dry_run=True):\n    return plan.describe() if dry_run else plan.execute()',
  },
];

/**
 * Words that look like a guard and gate nothing.
 *
 * Each is a shape that has already fooled some checker somewhere: a plan written in a comment, a
 * docstring example, and the word inside a string. Counting any of them would let this check
 * report a gate in a project that has none, which is worse than missing one - it is the direction
 * that reads as reassurance.
 */
const DECOYS: Case[] = [
  {
    framework: 'a plan in a comment',
    source: 'the commonest false positive in any grep-based checker',
    kind: 'asks-a-person',
    file: 'todo.py',
    body: ['def refund(order_id):', '    # TODO: add human_input=True here before we ship this', '    return charge.refund(order_id)'].join(NL),
    why: 'it is a note about a gate somebody intends to add. Nothing stops and asks anybody',
  },
  {
    framework: 'a docstring showing the option',
    source: 'how framework wrappers document themselves',
    kind: 'step-budget',
    file: 'wrapper.py',
    body: ['def build(agent):', '    """Build the executor.', '', '    Pass max_iterations=6 to cap the loop.', '    """', '    return AgentExecutor(agent=agent, tools=tools)'].join(NL),
    why: 'it documents an option the code does not set. The executor it builds has no ceiling',
  },
  {
    framework: 'a schema declaring the option exists',
    source: 'how any tool publishes its own configuration surface',
    kind: 'step-budget',
    file: 'schema.ts',
    body: [
      'export const configSchema = {',
      '  type: "object",',
      '  properties: {',
      '    max_iterations: { type: "integer", description: "cap the loop" },',
      '    recursion_limit: { type: "integer" },',
      '  },',
      '};',
    ].join(NL),
    why: 'it describes an option a caller may pass. This project sets no ceiling anywhere; it only says one can be set',
  },
  {
    framework: 'the word inside a string',
    source: 'log lines and help text',
    kind: 'dry-run',
    file: 'cli.py',
    body: ['def main():', '    print("pass --dry-run to see what would happen")', '    return apply(plan)'].join(NL),
    why: 'it is help text about a flag this code does not implement',
  },
];

export interface Measured {
  framework: string;
  kind: GuardKind;
  source: string;
  found: boolean;
  why?: string;
}

export function measure(): { frameworks: Measured[]; decoys: Measured[] } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-guard-recall-'));
  try {
    for (const c of [...CASES, ...DECOYS]) {
      mkdirSync(join(root, c.file, '..'), { recursive: true });
      writeFileSync(join(root, c.file), c.body, 'utf8');
    }
    // scanAgent rather than guardsIn: the walk and the blanking are part of the answer, and a
    // measurement that skipped them would be about a function instead of about the command.
    const guards = scanAgent(root).guards;
    const judge = (c: Case): Measured => ({
      framework: c.framework,
      kind: c.kind,
      source: c.source,
      found: guards.some((g) => g.file.endsWith(c.file.replace(/\\/g, '/')) && g.kind === c.kind),
      why: c.why,
    });
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
      "# the guards half of agent, measured against each framework's own documentation",
      '',
      `${frameworks.length} gates, each written the way the page that documents it writes it, and`,
      `${decoys.length} decoys that look like gates and stop nothing.`,
      '',
      `Gates found:            ${found.length} of ${frameworks.length} (${pct(found.length)})`,
      `Invented from a decoy:  ${invented.length} of ${decoys.length}`,
      '',
      '## Gates it cannot see',
      '',
      ...(frameworks.filter((f) => !f.found).length === 0
        ? ['None.']
        : frameworks.filter((f) => !f.found).map((f) => `- **${f.framework}** — \`${f.kind}\`, documented at ${f.source}`)),
      '',
      '## Gates it invented',
      '',
      ...(invented.length === 0 ? ['None of them was counted as a guard.'] : invented.map((d) => `- **${d.framework}** — ${d.why}`)),
      '',
      '---',
      '',
      'Why a miss here is the worst kind: the sentence this check produces when it finds nothing is',
      '"nothing anywhere in this project asks a person anything", in bold, about an agent that can',
      'delete and pay. A shape it cannot parse produces that sentence just as readily as a project',
      'with no gate at all. What this cannot measure is whether a gate that exists stands in front',
      'of the tool that issues refunds, which is a property of the running graph; the report says so',
      'in those words rather than implying otherwise.',
      '',
    ].join(NL),
  );
}

if (process.argv[1]?.includes('guard-recall')) report();
