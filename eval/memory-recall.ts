// OWASP ASI06, measured: outside text written somewhere the agent will read it back.
//
// `injection-recall.ts` measures the same question for one request. This measures the one that
// outlives it. OWASP records that ASI06 leads to ASI01 - a planted memory is how somebody changes
// what the agent is trying to do tomorrow - and it is the risk in that list with the longest reach
// per successful attempt: written once, retrieved for everyone, forever.
//
// Every case is the write the library's own documentation uses. The decoys are the point, as ever:
// `.add(` is a Set, a cart, a canvas and a counter long before it is a memory, and a check that
// reports one in every file it reads is a check nobody leaves switched on.
//
// Run: node eval/memory-recall.ts
import { memoryFlows } from '../engine/agent/memory-flow.ts';

const NL = String.fromCharCode(10);

interface Case {
  library: string;
  /** Where the write is documented, so the ground truth is somebody else's. */
  source: string;
  file: string;
  body: string;
  /** For a decoy: why counting it would be wrong. */
  why?: string;
}

const CASES: Case[] = [
  {
    library: 'LangChain vector store, Python',
    source: 'python.langchain.com vectorstores — add_texts',
    file: 'ingest_py.py',
    body: ['def ingest(url):', '    page = requests.get(url).text', '    vectorstore.add_texts([page])'].join(NL),
  },
  {
    library: 'LangChain vector store, documents',
    source: 'python.langchain.com vectorstores — add_documents',
    file: 'ingest_docs.py',
    body: ['def ingest(url):', '    html = requests.get(url).text', '    store.add_documents([Document(page_content=html)])'].join(NL),
  },
  {
    library: 'Pinecone upsert, JavaScript',
    source: 'docs.pinecone.io — upsert',
    file: 'upsert.ts',
    body: ['async function ingest(url: string) {', '  const res = await fetch(url).then((r) => r.text());', '  await index.upsert([{ id: "1", values: res }]);', '}'].join(NL),
  },
  {
    library: 'LangChain conversation memory',
    source: 'python.langchain.com memory — save_context',
    file: 'remember.py',
    body: ['def handle(issue):', '    memory.save_context({"input": issue.body}, {"output": reply})'].join(NL),
  },
  {
    library: 'a retrieved document written back to the index',
    source: 'the shape every RAG ingestion pipeline is written in',
    file: 'reindex.py',
    body: ['def reindex(q):', '    doc = retriever.invoke(q)', '    vectorstore.add_texts([doc.page_content])'].join(NL),
  },
  {
    library: 'a tool result kept as memory',
    source: 'the output of one tool stored for the next turn, as the agent loops',
    file: 'loop.ts',
    body: ['async function step(toolResult: string) {', '  await memoryStore.add_memory(toolResult);', '}'].join(NL),
  },
];

const DECOYS: Case[] = [
  {
    library: 'a Set',
    source: 'the commonest `.add(` in any codebase',
    file: 'dedupe.ts',
    body: ['function unique(items: string[]) {', '  const seen = new Set<string>();', '  for (const i of items) seen.add(i);', '  return seen;', '}'].join(NL),
    why: 'it is a set of strings in one function. Nothing persists and nothing is ever retrieved',
  },
  {
    library: 'a list being appended to',
    source: 'how every program in the world collects results',
    file: 'collect.py',
    body: ['def collect(url):', '    page = requests.get(url).text', '    results.append(page)'].join(NL),
    why: 'it is a local list. `append` is deliberately not a store write, or this check would report one in every file it read',
  },
  {
    library: 'outside text that goes nowhere',
    source: 'a fetch whose result is printed and dropped',
    file: 'show.py',
    body: ['def show(url):', '    page = requests.get(url).text', '    print(page)'].join(NL),
    why: 'the text is untrusted and is never stored. A source with no sink is not a flow',
  },
  {
    library: 'a store written from a trusted constant',
    source: 'seeding an index at start-up',
    file: 'seed.ts',
    body: ['async function seed() {', '  await index.upsert([{ id: "1", values: "our own product description" }]);', '}'].join(NL),
    why: 'the store write is real and what goes in is the project’s own text. A sink with no untrusted source is not a flow either',
  },
  {
    library: 'the store itself named like a source',
    source: 'the false positive a looser argument test would produce',
    file: 'rotate.py',
    body: ['def rotate(store):', '    store.add_texts(["scheduled maintenance note"])'].join(NL),
    why: 'the receiver of the write is not the thing written. Starting the argument scan after the opening parenthesis is what keeps this uncounted',
  },
];

export interface Measured { library: string; found: boolean }

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { flows: Measured[]; decoys: Measured[] } {
  return {
    flows: CASES.map((c) => ({ library: c.library, found: memoryFlows(c.file, c.body).length > 0 })),
    decoys: DECOYS.map((d) => ({ library: d.library, found: memoryFlows(d.file, d.body).length > 0 })),
  };
}

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

function report(): void {
  const found = CASES.filter((c) => memoryFlows(c.file, c.body).length > 0);
  const invented = DECOYS.filter((d) => memoryFlows(d.file, d.body).length > 0);
  const lines = [
    '# memory poisoning (OWASP ASI06), measured against each library’s own write',
    '',
    `${CASES.length} documented writes of outside text into a store that outlives the request, and`,
    `${DECOYS.length} decoys that look like one and keep nothing.`,
    '',
    `Flows found:            ${found.length} of ${CASES.length} (${pct(found.length, CASES.length)})`,
    `Invented from a decoy:  ${invented.length} of ${DECOYS.length}`,
    '',
  ];
  const missed = CASES.filter((c) => !found.includes(c));
  if (missed.length > 0) {
    lines.push('## Writes it cannot see', '');
    for (const c of missed) lines.push(`- **${c.library}** — documented at ${c.source}`);
    lines.push('');
  }
  if (invented.length > 0) {
    lines.push('## Invented', '');
    for (const d of invented) lines.push(`- **${d.library}** — ${d.why}`);
    lines.push('');
  } else {
    lines.push('## Invented', '', 'None of them was counted as a flow.', '');
  }
  lines.push(
    '---',
    '',
    'What this cannot measure is whether the store is ever read back into a prompt. That happens in a',
    'later request, through code this check does not follow, so the claim is that the door exists and',
    'not that somebody walked through it. The report says so in those words rather than implying more.',
    '',
  );
  process.stdout.write(lines.join(NL));
  if (invented.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
