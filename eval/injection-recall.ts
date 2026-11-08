// How much of the prompt-injection half of `tewip agent` is real, measured both ways.
//
// `agent` reports three things: the tools a model may call, the guards standing in front of them,
// and text from outside glued into a prompt. Only the first had a measured number. The evidence
// pack quoted that number - "10 of 10 framework shapes read" - underneath every claim the command
// makes, including the injection flows, which nothing had ever measured. A confidence figure
// standing in for a claim it was not measured on is worse than no figure, because it is believed.
//
// The positives are the shape each framework's own documentation uses to glue a retrieved
// document, a ticket body or a fetched page into a prompt. A miss is a framework whose documented
// shape Tewip walks past, and silence there reads as "nothing untrusted reaches the model here".
//
// The decoys are not invented. Every one is real code from the corpus that this check accused:
// three findings on n8n, all three false. They are kept as decoys because a fix that stops
// reporting them while still finding the positives is the only kind worth having.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptFlows } from '../engine/agent/prompt-flow.ts';

const NL = String.fromCharCode(10);

interface Case {
  /** What this is, named by where the shape comes from rather than by any rule. */
  what: string;
  file: string;
  body: string;
  /** For a decoy: why reporting it is wrong, in words somebody can check against the code. */
  why?: string;
}

/** Gluing outside text into a prompt, in the shape each framework's own documentation shows. */
const FLOWS: Case[] = [
  {
    what: 'LangChain, a retrieved document in an f-string prompt',
    file: 'rag.py',
    body: [
      'def answer(question, retriever, llm):',
      '    docs = retriever.invoke(question)',
      '    prompt = f"Use the context below.\\n{docs}\\nQuestion: {question}"',
      '    return llm.invoke(prompt, tools=TOOLS)',
    ].join(NL),
  },
  {
    what: 'Anthropic SDK, a fetched page in a messages array',
    file: 'summarise.ts',
    body: [
      'export async function summarise(url: string) {',
      '  const page = await fetch(url).then((r) => r.text());',
      '  return client.messages.create({',
      '    model: "claude-sonnet-5-5",',
      '    messages: [{ role: "user", content: `Summarise this page:\\n${page}` }],',
      '    tools: TOOLS,',
      '  });',
      '}',
    ].join(NL),
  },
  {
    what: 'OpenAI SDK, a ticket body concatenated into a system prompt',
    file: 'triage.ts',
    body: [
      'export async function triage(ticket: Ticket) {',
      '  const body = ticket.body;',
      '  return openai.chat.completions.create({',
      '    messages: [{ role: "system", content: "Classify this ticket: " + body }],',
      '    tools: TOOLS,',
      '  });',
      '}',
    ].join(NL),
  },
  {
    what: 'LangChain Python, an email body in a PromptTemplate',
    file: 'inbox.py',
    body: [
      'def handle(mail, chain):',
      '    payload = mail.body',
      '    template = ChatPromptTemplate.from_template(f"Reply to this message: {payload}")',
      '    return chain.invoke({"template": template}, tools=TOOLS)',
    ].join(NL),
  },
  {
    what: 'requests, a fetched page glued straight into a completion call',
    file: 'fetcher.py',
    body: [
      'def read(url, client):',
      '    page = requests.get(url).text',
      '    return client.create(messages=f"What does this say? {page}", tools=TOOLS)',
    ].join(NL),
  },
  {
    what: 'a ticket body in a camelCase variable, which is how TypeScript names things',
    file: 'camel.ts',
    // The keywords are lowercase and the patterns are case-sensitive, so `myissue.body` is found
    // and `myIssue.body` is not - backwards for the language most agents are written in.
    body: [
      'export async function triage(myIssue: Issue) {',
      '  const text = myIssue.body;',
      '  return client.messages.create({ messages: [{ role: "user", content: `Classify: ${text}` }], tools: TOOLS });',
      '}',
    ].join(NL),
  },
  {
    what: 'a retrieved document in a camelCase variable',
    file: 'camel-doc.ts',
    // The retriever call is deliberately *not* here. With `retriever.invoke(...)` in the function
    // this case passed, and it passed through the retriever pattern rather than through `topDoc` -
    // so it reported success for the camelCase reader while that reader was blind. The document
    // arrives as a parameter, which leaves the camelCase keyword as the only way to find it.
    body: [
      'export async function answer(question: string, topDoc: Document) {',
      '  return llm.invoke(`Context: ${topDoc.pageContent}\\nQ: ${question}`, { tools: TOOLS });',
      '}',
    ].join(NL),
  },
  {
    what: 'the output of another tool fed back into the next prompt',
    file: 'loop.py',
    body: [
      'def step(state, llm):',
      '    tool_result = state["last"]',
      '    return llm.invoke(f"Given {tool_result}, what next?", tools=TOOLS)',
    ].join(NL),
  },
];

/**
 * Code that is not a prompt-injection flow, and that this check reported as one.
 *
 * The first two are the whole of what `tewip agent` found on n8n: 11,054 files, three findings,
 * nought right. The third is the same shape as the first in a type declaration rather than a
 * formatter, which is where `toolResult` most often appears.
 */
const DECOYS: Case[] = [
  {
    what: 'n8n, a display formatter building a label',
    file: 'llm-step-display.ts',
    // The surrounding code is part of the case, not padding. The first version of this decoy was
    // the function alone, it passed, and the real file went on being reported: a file about
    // displaying LLM steps has `messages:`, `prompt` and `role:` all through it, so any test that
    // looks "nearby" for a model finds one. A decoy that cannot reproduce the context cannot
    // measure the fix, and this one quietly reported success for a defect that was still live.
    body: [
      'export function userMessageToBlock(message: ChatMessage): ReadableContentBlock {',
      '  return { role: "user", content: message.text, segments: [] };',
      '}',
      '',
      'export function toPrompt(history: ChatMessage[]) {',
      '  return { messages: history.map((h) => ({ role: h.role, content: h.text })) };',
      '}',
      '',
      'function toolResultToBlock(toolResult: ReadableToolCallBlock): ReadableContentBlock {',
      '  return {',
      '    role: "tool",',
      '    content: toolResult.name ? `[tool-result: ${toolResult.name}]` : "[tool-result]",',
      '    segments: [{ type: "tool-result", name: toolResult.name }],',
      '  };',
      '}',
    ].join(NL),
    why: 'it builds a label for a user interface. No model is called anywhere in the function, and `content:` is an object key, not a prompt',
  },
  {
    what: 'n8n, a chat record accumulating its own text',
    file: 'stream-capturer.ts',
    body: [
      'async function fail(key: string, content: string) {',
      '  const message = await ensureMessage(key);',
      '  message.status = "error";',
      '  if (typeof content === "string") {',
      '    message.content = (message.content ? message.content + "\\n\\n" : "") + content;',
      '  }',
      '}',
    ].join(NL),
    why: 'the value is appended to the very field it was read from. Gluing a value into itself is not gluing it into a prompt, and no model is called',
  },
  {
    what: 'a type declaration naming a tool result',
    file: 'types.ts',
    body: ['export interface Step {', '  toolResult: string;', '  content: string;', '}'].join(NL),
    why: 'it declares the shape of a record. Nothing is read and nothing is built',
  },
  {
    what: 'a chat record accumulating its own text, in a file that does call a model',
    file: 'accumulate.ts',
    body: [
      'async function fail(key: string, content: string) {',
      '  const message = await ensureMessage(key);',
      '  message.content = (message.content ? message.content + "\\n\\n" : "") + content;',
      '  await llm.invoke({ messages: [{ role: "user", content: "unrelated" }] });',
      '}',
    ].join(NL),
    why: 'the value is appended to the field it was read from. The model call in the same body is a different statement, so requiring a model nearby does not settle this one',
  },
  {
    what: 'a log line, not a prompt',
    file: 'log.ts',
    body: [
      'export function trace(issue: Issue) {',
      '  const body = issue.body;',
      '  logger.info({ content: `issue ${issue.id}: ${body}` });',
      '}',
    ].join(NL),
    why: 'the text goes to a log. `content:` matched, and a logger is not a model',
  },
];

export interface Measured {
  what: string;
  found: boolean;
  why?: string;
}

export function measure(): { flows: Measured[]; decoys: Measured[] } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-injection-recall-'));
  try {
    const judge = (c: Case): Measured => {
      const path = join(root, c.file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, c.body, 'utf8');
      // promptFlows directly, not scanAgent: the question is about this reader, and a file-set
      // filter deciding the answer would make the number about the walk instead.
      return { what: c.what, found: promptFlows(c.file, readFileSync(path, 'utf8')).length > 0, why: c.why };
    };
    return { flows: FLOWS.map(judge), decoys: DECOYS.map(judge) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function report(): void {
  const { flows, decoys } = measure();
  const found = flows.filter((f) => f.found);
  const accused = decoys.filter((d) => d.found);
  const pct = (n: number) => `${((n / flows.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      '# the prompt-injection half of agent, measured',
      '',
      `${flows.length} flows, each gluing outside text into a prompt the way its framework's own`,
      `documentation does it, and ${decoys.length} decoys - every one real code this check accused.`,
      '',
      `Flows found:            ${found.length} of ${flows.length} (${pct(found.length)})`,
      `Decoys accused:         ${accused.length} of ${decoys.length}`,
      '',
      '## Flows it walks past',
      '',
      ...(flows.filter((f) => !f.found).length === 0 ? ['None.'] : flows.filter((f) => !f.found).map((f) => `- **${f.what}**`)),
      '',
      '## Code it wrongly calls a prompt-injection flow',
      '',
      ...(accused.length === 0 ? ['None of them was reported.'] : accused.map((d) => `- **${d.what}** — ${d.why}`)),
      '',
      '---',
      '',
      'What this rests on: the positives are the shapes the frameworks publish, so a miss is a shape',
      'Tewip has no reader for rather than a trick. The decoys are the opposite of planted - they are',
      'what this check already got wrong on one real repository, kept so that a fix has to keep',
      'finding the positives to count. What none of it measures is a flow that crosses a function or',
      'a file boundary, which this check refuses by design and says so in its own report.',
      '',
    ].join(NL),
  );
}

if (process.argv[1]?.includes('injection-recall')) report();
