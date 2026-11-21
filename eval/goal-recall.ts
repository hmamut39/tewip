// OWASP ASI01, measured: untrusted text reaching the system prompt rather than a turn.
//
// `injection-recall.ts` next door measures whether the flow is found at all. This measures the
// distinction on top of it, which is a different question and the one OWASP puts first: text in a
// user turn can produce a wrong answer, and text in the system prompt rewrites what the agent is
// *for* - for every turn after it, and for whoever talks to it next.
//
// So every case here is already a flow. What is being scored is whether `goal` is set correctly,
// and the decoys are flows that must be found and must **not** be escalated. That shape matters:
// this check cannot invent a finding, only make a real one sound worse than it is, which is its own
// kind of wrong and the only kind available here.
//
// Run: node eval/goal-recall.ts
import { promptFlows } from '../engine/agent/prompt-flow.ts';

const NL = String.fromCharCode(10);

interface Case {
  /** The framework shape, named by where it comes from. */
  what: string;
  file: string;
  body: string;
  /** For a decoy: why escalating it would be wrong. */
  why?: string;
}

const UNTRUSTED_PY = '    page = requests.get(url).text';
const UNTRUSTED_TS = '  const page = await fetch(url).then((r) => r.text());';

const GOALS: Case[] = [
  {
    what: 'LangChain SystemMessage',
    file: 'lc.py',
    body: ['def build(url):', UNTRUSTED_PY, '    msgs = [SystemMessage(content=f"You are an agent. {page}")]'].join(NL),
  },
  {
    what: 'OpenAI messages, the system role',
    file: 'openai.py',
    body: ['def build(url):', UNTRUSTED_PY, '    messages=[{"role": "system", "content": f"Context: {page}"}]'].join(NL),
  },
  {
    what: 'the Anthropic and Vercel `system:` property beside messages',
    file: 'vercel.ts',
    body: ['async function f(url: string) {', UNTRUSTED_TS, '  await generateText({ system: `You are helpful. ${page}`, messages });', '}'].join(NL),
  },
  {
    what: 'ChatPromptTemplate.from_messages, the ("system", ...) tuple',
    file: 'tmpl.py',
    body: ['def build(url):', UNTRUSTED_PY, '    tmpl = ChatPromptTemplate.from_messages([("system", f"Rules: {page}")])'].join(NL),
  },
  {
    what: 'the OpenAI Agents SDK, which calls it instructions',
    file: 'agents.py',
    body: ['def build(url):', UNTRUSTED_PY, '    agent = Agent(name="a", instructions=f"You must: {page}")'].join(NL),
  },
  {
    what: 'a named system_prompt variable, two hops from the source',
    file: 'named.ts',
    body: ['async function f(url: string) {', UNTRUSTED_TS, '  const systemPrompt = `You are an agent. ${page}`;', '  await llm.invoke({ system: systemPrompt });', '}'].join(NL),
    why: 'kept although no flow is found, and it must not be "fixed" here. The chain is page -> systemPrompt -> system:, which is two hops, and this project refuses anything past one everywhere it reads a flow. Widening it for this one check would buy a case and spend the property that makes every other finding worth reading',
  },
];

const TURNS: Case[] = [
  {
    what: 'the user role, which is where outside text belongs',
    file: 'user.py',
    body: ['def build(url):', UNTRUSTED_PY, '    messages=[{"role": "user", "content": f"Summarise: {page}"}]'].join(NL),
    why: 'this is a real flow and must be reported. It is not a goal hijack: a wrong answer is the worst case, not a rewritten purpose',
  },
  {
    what: 'a HumanMessage',
    file: 'human.py',
    body: ['def build(url):', UNTRUSTED_PY, '    msgs = [HumanMessage(content=f"Here is the page: {page}")]'].join(NL),
    why: 'the same, in LangChain words',
  },
  {
    what: 'a prompt with no role at all',
    file: 'plain.ts',
    body: ['async function f(url: string) {', UNTRUSTED_TS, '  await llm.invoke(`Summarise this: ${page}`);', '}'].join(NL),
    why: 'nothing here says system. Escalating a flow because it could not be classified is how a report stops being read',
  },
  {
    what: 'the word system meaning something else entirely',
    file: 'word.ts',
    body: ['async function f(url: string) {', UNTRUSTED_TS, '  await llm.invoke(`Our design system docs say: ${page}`);', '}'].join(NL),
    why: '`design system` in prose. The word appears in half the codebases in the world and must not be read as a role',
  },
];

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

export interface Measured {
  what: string;
  /** Whether the flow was found at all; a case this misses is a hole in injection-recall, not here. */
  flow: boolean;
  /** Whether it was escalated to a goal hijack. */
  goal: boolean;
  why?: string;
}

const judge = (c: Case): Measured => {
  const flows = promptFlows(c.file, c.body);
  return { what: c.what, flow: flows.length > 0, goal: flows.some((f) => f.goal), why: c.why };
};

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { goals: Measured[]; turns: Measured[] } {
  return { goals: GOALS.map(judge), turns: TURNS.map(judge) };
}

function report(): void {
  const { goals, turns } = measure();
  const escalated = goals.filter((g) => g.goal);
  const reachable = goals.filter((g) => g.flow);
  const wrongly = turns.filter((t) => t.goal);
  const lost = turns.filter((t) => !t.flow);
  const lines = [
    '# goal hijack (OWASP ASI01), measured against each framework’s own system prompt',
    '',
    `${GOALS.length} flows into a system prompt, written the way each framework writes one, and`,
    `${TURNS.length} flows into a turn that must be reported and must not be escalated.`,
    '',
    `System prompts recognised:  ${escalated.length} of ${reachable.length} that reach this reader (${pct(escalated.length, reachable.length)})`,
    `Not reachable at all:       ${GOALS.length - reachable.length} of ${GOALS.length}, named below`,
    `Turns wrongly escalated:    ${wrongly.length} of ${TURNS.length}`,
    `Turns lost altogether:      ${lost.length} of ${TURNS.length}`,
    '',
  ];
  // Said apart, because they are different failures. A flow that was never found is a hole in
  // `injection-recall.ts`; a flow found and not escalated is a hole in this one.
  const noFlow = goals.filter((g) => !g.flow);
  const notEscalated = goals.filter((g) => g.flow && !g.goal);
  if (notEscalated.length > 0) lines.push('## System prompts it reads as ordinary turns', '', ...notEscalated.map((g) => `- **${g.what}**`), '');
  if (noFlow.length > 0) {
    lines.push('## Cases where no flow is found at all', '', ...noFlow.map((g) => `- **${g.what}** — ${g.why ?? 'unexplained'}`), '');
  }
  if (wrongly.length > 0) lines.push('## Turns it calls a goal hijack', '', ...wrongly.map((t) => `- **${t.what}** — ${t.why}`), '');
  if (lost.length > 0) lines.push('## Flows it stopped finding', '', ...lost.map((t) => `- **${t.what}**`), '');
  if (notEscalated.length === 0 && wrongly.length === 0 && lost.length === 0) lines.push('Every system prompt that reaches this reader is named, and every turn is kept as a turn.', '');
  lines.push(
    '---',
    '',
    'The failure available here is not a false finding - every case is already a flow that',
    '`injection-recall.ts` scores. It is a real finding made to sound worse than it is, which is why',
    'the four turns are weighted the same as the six system prompts: a check that escalates what it',
    'cannot classify is one people stop reading, and then the escalation is worth nothing when it is',
    'right.',
    '',
  );
  process.stdout.write(lines.join(NL));
  if (wrongly.length > 0 || lost.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
