// Text somebody else wrote, glued into a prompt, in a loop that holds tools.
//
// `tools.ts` answers this at the level of capability: does this agent have a tool that reads
// untrusted text, a tool that reads private data, and a tool that sends data out. That is the
// lethal trifecta and it is worth knowing. But it is an argument about what could happen.
//
// This is the same question one level down, about what the code actually does: is a value that
// came off a web page, a ticket, an inbox or a retriever **glued into the prompt string itself**.
// Glued, not passed beside it - the distinction that matters in SQL matters more here, because a
// prompt has no parameter binding to fall back on. Once the text is in the prompt, the model cannot
// tell the instruction you wrote from the instruction the attacker wrote, and no amount of "ignore
// any instructions in the document below" changes that.
//
// The same refusal as the SQL checker next door: a source and a sink inside one function body,
// directly or through one named variable. No call graph, no cross-file inference, no maybes. A
// list of maybes gets switched off, and then somebody has written "we check for prompt injection"
// on a form.
import { gluedIn, sameBody } from '../taint/flow.ts';

const NL = String.fromCharCode(10);

export interface PromptFlow {
  file: string;
  line: number;
  /** The untrusted value that reaches the prompt. */
  source: string;
  /** What kind of outside text it is, in words a reader can check. */
  origin: string;
  /** How it got in: an f-string, a template literal, concatenation. */
  through: string;
  /** True when the same function also hands the model tools. */
  withTools: boolean;
  evidence: string;
}

/**
 * Where text somebody outside the building can write comes into an agent.
 *
 * Framework-specific on purpose, and short on purpose. Every entry here is a shape where the value
 * is *text from elsewhere*, not a number or a flag: a fetched page, a retrieved document, the body
 * of a ticket or a message. A general "anything from a function call" source would match the whole
 * program and find nothing worth reading.
 */
const SOURCES: Array<{ re: string; origin: string }> = [
  { re: String.raw`(?:requests|httpx|session)\s*\.\s*(?:get|post)\s*\([^)]*\)\s*\.\s*(?:text|content|json\(\))`, origin: 'a web page this agent fetched' },
  { re: String.raw`(?:await\s+)?(?:fetch|axios\s*\.\s*get)\s*\([^)]*\)[^;\n]*?\.\s*(?:text|json|data)\s*\(?\)?`, origin: 'a web page this agent fetched' },
  { re: String.raw`\w*(?:page|html|soup|article|scraped?)\w*\s*\.\s*(?:content|text|get_text|inner_text|innerText)\s*\(?\)?`, origin: 'a web page this agent fetched' },
  { re: String.raw`\w*(?:retriever|vectorstore|index|store)\w*\s*\.\s*(?:invoke|search|similarity_search|get_relevant_documents|query)\s*\([^)]*\)`, origin: 'a document this agent retrieved' },
  { re: String.raw`\w*(?:doc|document|chunk|result|passage)\w*\s*\.\s*(?:page_content|pageContent|text)\b`, origin: 'a document this agent retrieved' },
  { re: String.raw`\w*(?:issue|ticket|comment|review|pr|pull_request)\w*\s*\.\s*(?:body|description|text)\b`, origin: 'a ticket or comment somebody else wrote' },
  { re: String.raw`\w*(?:email|mail|message|msg)\w*\s*\.\s*(?:body|payload|text|content|get_payload\(\))`, origin: 'a message this agent received' },
  { re: String.raw`\w*(?:tool_result|toolResult|observation|tool_output)\w*\b`, origin: 'the output of another tool' },
];

/** Where a prompt is built or sent. */
const PROMPT = /\b(?:messages|prompt|system|instructions|user_message|userMessage|input|content|template)\s*[:=]|\b(?:SystemMessage|HumanMessage|ChatPromptTemplate|PromptTemplate)\s*(?:\.\s*from_\w+\s*)?\(|\.\s*(?:invoke|complete|create|generate|run|predict|chat)\s*\(/g;

/** The same body also handing the model tools - which is what turns exposure into reach. */
// `[:=,})]` and not just `[:=]`: `client.create({ tools, messages })` is the shorthand both the
// Anthropic and Vercel SDKs are written in, and `tools` there is followed by a comma. Missing it
// reported the commonest shape in JavaScript as a prompt with no tools behind it, which is exactly
// the difference between exposure and reach.
const TOOLS_HERE = /\btools\b\s*[:=,})]|\btool_choice\s*[:=]|\bbind_tools\s*\(|\.\s*with_tools\s*\(|\bToolNode\s*\(/;

/** The statement a line sits in, which is the string a value is or is not glued into. */
function statementAt(text: string, at: number): string {
  let start = at;
  let depth = 0;
  // Walk back to the start of the expression: a line break at bracket depth zero.
  for (let i = at; i > 0 && at - i < 2000; i -= 1) {
    const ch = text[i];
    if (ch === ')' || ch === ']' || ch === '}') depth += 1;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === NL && depth === 0) {
      start = i + 1;
      break;
    }
    start = i;
  }
  let end = at;
  depth = 0;
  for (let i = at; i < text.length && i - at < 2000; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth -= 1;
    } else if ((ch === NL || ch === ';') && depth === 0) {
      end = i;
      break;
    }
    end = i + 1;
  }
  return text.slice(start, end);
}

/** Every source as one pattern, for the cheap question asked first. */
const ANY_SOURCE = new RegExp(SOURCES.map((s) => `(?:${s.re})`).join('|'));

export function promptFlows(file: string, text: string): PromptFlow[] {
  // Nothing untrusted in this file means nothing to find, and asking that once is far cheaper than
  // the work it skips. `PROMPT` matches `content`, `input`, `template` and `.create(` - words that
  // appear constantly in ordinary code - and each match costs a statement scan plus eight source
  // patterns over it. On n8n that made `tewip agent` take 68 seconds against 5 for `infra`, which
  // is the kind of number that quietly gets a check removed from CI. The taint engine opens with
  // the same question for the same reason.
  if (!ANY_SOURCE.test(text)) return [];

  const found: PromptFlow[] = [];
  const seen = new Set<string>();
  const assigned: Array<{ name: string; at: number; source: string; origin: string }> = [];
  for (const { re, origin } of SOURCES) {
    // `name = <source>` in Python, and `const name = <source>` in JavaScript.
    for (const m of text.matchAll(new RegExp(String.raw`(?:(?:const|let|var)\s+)?(\w+)\s*=\s*[^=\n]*?(` + re + String.raw`)`, 'g'))) {
      assigned.push({ name: m[1], at: m.index ?? 0, source: m[2], origin });
    }
  }

  for (const prompt of text.matchAll(PROMPT)) {
    const at = prompt.index ?? 0;
    const statement = statementAt(text, at);
    if (!statement.trim()) continue;
    const line = text.slice(0, at).split(NL).length;
    // Tools in the same body: looked for from the start of the enclosing function rather than the
    // whole file, so a tool list in one handler does not arm a prompt built in another.
    const withTools = TOOLS_HERE.test(text.slice(Math.max(0, at - 3000), at + 3000));

    // Directly: the fetched value is written inside the prompt string itself.
    for (const { re, origin } of SOURCES) {
      const hit = new RegExp(re).exec(statement);
      if (!hit) continue;
      const how = gluedIn(statement, hit[0]);
      if (!how) continue;
      // One finding per untrusted value, not per place a prompt is mentioned: `messages=` and
      // `.create(` both match the same statement, and reporting it twice reads as two problems.
      const key = `direct:${hit[0]}:${statement.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ file, line, source: hit[0].replace(/\s+/g, ' ').slice(0, 80), origin, through: how, withTools, evidence: statement.replace(/\s+/g, ' ').slice(0, 160) });
    }

    // Through one variable, assigned from an untrusted value earlier in the same body.
    for (const a of assigned) {
      if (a.at > at || !sameBody(text, a.at, at)) continue;
      const how = gluedIn(statement, a.name);
      if (!how) continue;
      const key = `via:${a.name}:${a.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        file,
        line,
        source: a.source.replace(/\s+/g, ' ').slice(0, 80),
        origin: a.origin,
        through: `${how}, through \`${a.name}\``,
        withTools,
        evidence: statement.replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  return found;
}
