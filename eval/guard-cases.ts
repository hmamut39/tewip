// The documented shapes a guard takes, and the shapes that only look like one.
//
// Split out of `guard-recall.ts` in Phase 191, when adding a sandbox and a spend cap took that
// file past this project's 300-line rule. Nothing here measures anything: it is the ground truth,
// each case carrying the page that publishes it, so the harness beside it is only the arithmetic.
import { type GuardKind } from '../engine/agent/guards.ts';

const NL = String.fromCharCode(10);
export interface Case {
  framework: string;
  /** Where the shape is published, so the ground truth is somebody else's. */
  source: string;
  kind: GuardKind;
  file: string;
  body: string;
  /** For a decoy: why counting it as a guard would be wrong. */
  why?: string;
}

export const CASES: Case[] = [
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
  {
    framework: 'E2B code interpreter, Python',
    source: 'github.com/e2b-dev/code-interpreter and pypi.org/project/e2b-code-interpreter',
    kind: 'sandboxed',
    file: 'run_code.py',
    body: ['from e2b_code_interpreter import Sandbox', '', 'with Sandbox() as sandbox:', '    result = sandbox.run_code(generated)'].join(NL),
  },
  {
    framework: 'E2B, JavaScript',
    source: 'github.com/e2b-dev/code-interpreter, JavaScript SDK',
    kind: 'sandboxed',
    file: 'run_code.ts',
    body: 'const sandbox = await Sandbox.create();',
  },
  {
    framework: 'AutoGen, Azure dynamic sessions',
    source: 'autogen_ext.code_executors.azure, named in Modal’s AutoGen sandbox guide',
    kind: 'sandboxed',
    file: 'executor.py',
    body: 'executor = ACADynamicSessionsCodeExecutor(pool_management_endpoint=endpoint)',
  },
  // Kept although it is not found, and it must not be "fixed".
  //
  // The jailer is named inside a template literal, and `blank()` empties string contents before the
  // patterns run. That is the same rule that makes the `print("pass --dry-run ...")` decoy below
  // stay uncounted, and it cannot be relaxed for one kind without un-deciding the other. So a
  // sandbox invoked as a shell string is invisible here, which is a real shape and a real gap, and
  // the honest place for it is this list rather than a deleted case and a rounder number.
  {
    framework: 'a Linux jailer around a generated script',
    source: 'nsjail and firejail, the tools people reach for when there is no cloud sandbox',
    kind: 'sandboxed',
    file: 'jail.sh.ts',
    body: 'const cmd = `nsjail --really_quiet --config sandbox.cfg -- python ${script}`;',
  },
  {
    framework: 'LiteLLM proxy, global ceiling',
    source: 'docs.litellm.ai/docs/proxy/users — litellm_settings max_budget',
    kind: 'spend-cap',
    file: 'proxy_config.ts',
    body: ['export const litellm_settings = {', '  max_budget: 100.0,', '  budget_duration: "30d",', '};'].join(NL),
  },
  {
    framework: 'LiteLLM, per-model ceiling on a key',
    source: 'docs.litellm.ai/docs/proxy/budget_fallbacks — model_max_budget',
    kind: 'spend-cap',
    file: 'key_py.py',
    body: 'generate_key(model_max_budget={"gpt-4o": {"budget_limit": 10.0, "time_period": "1d"}})',
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
export const DECOYS: Case[] = [
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
  {
    framework: 'a price ceiling in a shop',
    source: 'the false positive this pattern was nearly written with',
    kind: 'spend-cap',
    file: 'pricing.ts',
    body: ['export function quote(items: Item[]) {', '  const max_cost = 500; // never quote above this', '  return Math.min(total(items), max_cost);', '}'].join(NL),
    why: 'it caps what a customer is charged, not what a model may spend. `max_cost` was in the first draft of this pattern and this case is why it is not in the shipped one',
  },
  {
    framework: 'a payments sandbox',
    source: 'every Stripe, PayPal and Adyen integration ever written',
    kind: 'sandboxed',
    file: 'payments.ts',
    body: ['export const stripe = new Stripe(key, {', '  sandbox: true,', '});'].join(NL),
    why: 'it is a test mode for a payment provider. No code the model wrote is isolated from anything',
  },
  {
    framework: 'a rate limit on an endpoint',
    source: 'the control the guardrail catalogues group with spend, and this one does not',
    kind: 'spend-cap',
    file: 'server.ts',
    body: 'app.use(rateLimit({ windowMs: 60_000, max: 100 }));',
    why: 'it throttles requests. It bounds nothing in dollars, and counting it would claim a budget ceiling in every backend that throttles an endpoint',
  },
];
