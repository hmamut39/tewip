// Text somebody else wrote, put somewhere the agent will read it back later.
//
// OWASP ASI06, Memory and Context Poisoning. `prompt-flow.ts` next door asks whether untrusted text
// reaches a prompt *in this request*. This asks the longer-lived question: is it written into a
// store that outlives the request, where it will be retrieved later - for this user or another one
// - and arrive looking like something the agent itself remembered.
//
// The two are different failures and the second is worse. An injected prompt is wrong once. An
// injected memory is wrong every time it is retrieved, for everyone it is retrieved for, and the
// text arrives carrying the authority of the agent's own history rather than of a web page. OWASP
// records that ASI06 frequently leads to ASI01, goal hijack, for exactly that reason: a planted
// memory is how an attacker changes what the agent is trying to do tomorrow.
//
// **The sink must persist.** A conversation buffer that lives for one request is not this problem,
// and reporting it would bury the finding that matters under every agent ever written - they all
// hold the turn they are in. So the sinks here are the shapes that write to a vector store, an
// index or a named memory service: things another request can read.
//
// The same refusal as both neighbours: a source and a sink inside one function body, directly or
// through one named variable. No call graph, no cross-file inference. A list of maybes gets
// switched off, and then somebody has written "we check for memory poisoning" on a form.
import { sameBody } from '../taint/flow.ts';
import { SOURCES } from './prompt-flow.ts';

const NL = String.fromCharCode(10);

export interface MemoryFlow {
  file: string;
  line: number;
  /** The untrusted value that reaches the store. */
  source: string;
  /** What kind of outside text it is, in words a reader can check. */
  origin: string;
  /** How it got in: written into the call, or through a named variable. */
  through: string;
  /** The store it was written to, quoted from the code. */
  store: string;
  evidence: string;
}

/**
 * Writes to something another request can read.
 *
 * Every name here is a documented write on a store that persists: LangChain's `add_texts` and
 * `add_documents`, Pinecone's `upsert`, Chroma's `add`, LangGraph's `store.put`, and the `add` of
 * the two memory services people actually install. `save_context` is LangChain's own memory write
 * and is included because the backing store is a constructor argument - a reader cannot tell from
 * the write whether it is in a process or in Redis, and the direction that errs toward reporting is
 * the right one for a sink.
 *
 * What is deliberately absent: `append`, `push`, `set`, `write` and `save` on their own. They are
 * how every program in the world puts something in a list, and a check that treated them as a
 * memory would report one in every file it read.
 */
const STORES = String.raw`(?:add_texts|aadd_texts|add_documents|aadd_documents|add_embeddings|upsert|save_context|asave_context|add_memory|put_memory|remember)`;

/**
 * The call that writes, with whatever it is called on.
 *
 * Two shapes. A named store method - `vectorstore.add_texts(...)`, `index.upsert(...)` - and the
 * memory services whose API is a bare `add` on an object whose name says what it is: `mem0`,
 * `Memory()`, `zep`. A bare `.add(` with no such name is not matched, because `.add(` is a set, a
 * cart, a canvas and a counter before it is ever a memory.
 */
const WRITE = new RegExp(
  String.raw`\w*(?:[Ss]tore|[Vv]ectorstore|[Ii]ndex|[Cc]ollection|[Mm]emory|[Rr]etriever|[Dd]b)\w*\s*\.\s*(?:${STORES}|put|add)\s*\(` +
    String.raw`|\b(?:mem0|zep|Mem0|Zep)\w*\s*\.\s*\w*\s*\.?\s*add\s*\(` +
    String.raw`|\.\s*(?:${STORES})\s*\(`,
  'g',
);

const statementAt = (text: string, at: number): string => {
  const start = Math.max(text.lastIndexOf(NL, at), text.lastIndexOf(';', at)) + 1;
  const stop = text.indexOf(NL, at + 1);
  return text.slice(start, stop === -1 ? text.length : stop);
};

/** `x = x + ...` is the variable being built, not an outside value arriving. */
const assignsToItself = (statement: string, source: string): boolean =>
  new RegExp(String.raw`^\s*(?:const|let|var)?\s*` + source.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) + String.raw`\s*=`).test(statement);

/**
 * The value is handed to the write, rather than merely sitting on the same line.
 *
 * Deliberately not `gluedIn`, which the prompt and SQL checks use. Those two care whether a value
 * was glued into a string, because the danger there is syntax: a quote closes a string and the rest
 * is parsed as instruction or as SQL. Storing a memory has no syntax to break. The danger is the
 * *content* being kept and read back, and content arrives as an ordinary argument - `add_texts([page])`
 * glues nothing and poisons the store exactly the same.
 *
 * So this asks the narrower question it can answer from one line: does the name appear inside the
 * call's own argument list. The write's own receiver is excluded by starting after the opening
 * parenthesis, so `store.add(x)` is never read as the store being the untrusted thing.
 */
function passedInto(statement: string, writeText: string, name: string): string | null {
  const at = statement.indexOf(writeText);
  if (at === -1) return null;
  const open = statement.indexOf('(', at);
  if (open === -1) return null;
  const args = statement.slice(open + 1);
  const found = args.indexOf(name);
  if (found === -1) return null;
  // Whole word, checked by its neighbours rather than by a regex built from a name -
  // a name is user data here and escaping it into a pattern is a step with nothing to gain.
  const isWord = (c: string): boolean => /[\w.]/.test(c);
  const before = args[found - 1] ?? ' ';
  const after = args[found + name.length] ?? ' ';
  return !isWord(before) && !/\w/.test(after) ? 'passed into the write' : null;

}

export function memoryFlows(file: string, text: string): MemoryFlow[] {
  const found: MemoryFlow[] = [];
  const seen = new Set<string>();
  const assigned: Array<{ name: string; at: number; source: string; origin: string }> = [];

  for (const { re, origin } of SOURCES) {
    for (const m of text.matchAll(new RegExp(String.raw`(?:(?:const|let|var)\s+)?(\w+)\s*=\s*[^=\n]*?(` + re + String.raw`)`, 'g'))) {
      assigned.push({ name: m[1], at: m.index ?? 0, source: m[2], origin });
    }
  }

  for (const write of text.matchAll(WRITE)) {
    const at = write.index ?? 0;
    const statement = statementAt(text, at);
    if (!statement.trim()) continue;
    const line = text.slice(0, at).split(NL).length;
    const store = write[0].replace(/\s+/g, ' ').slice(0, 60);

    // Written straight into the call.
    for (const { re, origin } of SOURCES) {
      const hit = new RegExp(re).exec(statement);
      if (!hit) continue;
      const how = passedInto(statement, write[0], hit[0]);
      if (!how || assignsToItself(statement, hit[0])) continue;
      const key = `direct:${hit[0]}:${statement.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ file, line, source: hit[0].replace(/\s+/g, ' ').slice(0, 80), origin, through: how, store, evidence: statement.replace(/\s+/g, ' ').slice(0, 160) });
    }

    // Through one variable, assigned from an untrusted value earlier in the same function.
    for (const a of assigned) {
      if (a.at > at || !sameBody(text, a.at, at)) continue;
      const how = passedInto(statement, write[0], a.name);
      if (!how || assignsToItself(statement, a.source)) continue;
      const key = `via:${a.name}:${a.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        file,
        line,
        source: a.source.replace(/\s+/g, ' ').slice(0, 80),
        origin: a.origin,
        through: `${how}, through \`${a.name}\``,
        store,
        evidence: statement.replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  return found;
}
