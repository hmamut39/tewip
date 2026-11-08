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
/**
 * A keyword that may arrive capitalised, because it is in the middle of an identifier.
 *
 * These patterns were lowercase and case-sensitive, so `myissue.body` was found and `myIssue.body`
 * was not - backwards for TypeScript, where camelCase is the convention and which is what most
 * agents are written in. Measured by eval/injection-recall.ts: two of its eight documented flows
 * were invisible for this reason alone.
 *
 * A helper over a list of words, deliberately not a derivation from a pattern's source. Twice this
 * week a clever derivation turned out to extract fragments rather than words - `tool_allow_?list`
 * yielding `list` - and the difference is that this takes whole words and only adds a case.
 */
const eitherCase = (...words: string[]): string => words.map((w) => `${w}|${w[0].toUpperCase()}${w.slice(1)}`).join('|');

export const SOURCES: Array<{ re: string; origin: string }> = [
  { re: String.raw`(?:requests|httpx|session)\s*\.\s*(?:get|post)\s*\([^)]*\)\s*\.\s*(?:text|content|json\(\))`, origin: 'a web page this agent fetched' },
  { re: String.raw`(?:await\s+)?(?:fetch|axios\s*\.\s*get)\s*\([^)]*\)[^;\n]*?\.\s*(?:text|json|data)\s*\(?\)?`, origin: 'a web page this agent fetched' },
  { re: String.raw`\w*(?:${eitherCase('page', 'html', 'soup', 'article', 'scraped?')})\w*\s*\.\s*(?:content|text|get_text|inner_text|innerText)\s*\(?\)?`, origin: 'a web page this agent fetched' },
  { re: String.raw`\w*(?:${eitherCase('retriever', 'vectorstore', 'index', 'store')})\w*\s*\.\s*(?:invoke|search|similarity_search|get_relevant_documents|query)\s*\([^)]*\)`, origin: 'a document this agent retrieved' },
  { re: String.raw`\w*(?:${eitherCase('doc', 'document', 'chunk', 'result', 'passage')})\w*\s*\.\s*(?:page_content|pageContent|text)\b`, origin: 'a document this agent retrieved' },
  // `pr` is anchored to a word boundary and kept out of the `\w*` group on purpose. Inside it, with
  // `\w*` on both sides, it matched `process.text`, `properties.text`, `preview.text`,
  // `expression.text`, `sprite.body` and `compressor.text` - ordinary TypeScript, all of it
  // reported as "a ticket or comment somebody else wrote". Capitalising the keywords would have
  // added `Pr` and taken `MyProcess.text` with it, so the two changes belong together.
  {
    re: String.raw`(?:\w*(?:${eitherCase('issue', 'ticket', 'comment', 'review', 'pull_request', 'pullRequest')})\w*|\bpr)\s*\.\s*(?:body|description|text)\b`,
    origin: 'a ticket or comment somebody else wrote',
  },
  { re: String.raw`\w*(?:${eitherCase('email', 'mail', 'message', 'msg')})\w*\s*\.\s*(?:body|payload|text|content|get_payload\(\))`, origin: 'a message this agent received' },
  { re: String.raw`\w*(?:${eitherCase('tool_result', 'toolResult', 'observation', 'tool_output')})\w*\b`, origin: 'the output of another tool' },
];

/** Where a prompt is built or sent. */
const PROMPT = /\b(?:messages|prompt|system|instructions|user_message|userMessage|input|content|template)\s*[:=]|\b(?:SystemMessage|HumanMessage|ChatPromptTemplate|PromptTemplate)\s*(?:\.\s*from_\w+\s*)?\(|\.\s*(?:invoke|complete|create|generate|run|predict|chat)\s*\(/g;

/**
 * Three of those words are not evidence of a prompt on their own.
 *
 * `content:`, `input:` and `template:` are ordinary object keys. On n8n this check reported three
 * flows across 11,054 files and every one of them was one of these words: a formatter building the
 * label `[tool-result: x]`, and `message.content = message.content + content` on a chat record.
 * Neither calls a model. The other words in PROMPT are different in kind - `messages:`, a
 * `ChatPromptTemplate`, an `.invoke(` - because nothing but a model call is written that way.
 *
 * So these three count only when something in the same body is unambiguously a model. That keeps
 * every documented framework shape, each of which has a strong sink of its own somewhere in the
 * call, and drops the three n8n findings. Both halves are measured by eval/injection-recall.ts.
 */
const WEAK_SINK = /^\s*(?:input|content|template)\s*[:=]/;
const A_MODEL_IS_HERE =
  /\b(?:messages|prompt|system|instructions|user_message|userMessage)\s*[:=]|\b(?:SystemMessage|HumanMessage|ChatPromptTemplate|PromptTemplate)\s*(?:\.\s*from_\w+\s*)?\(|\.\s*(?:invoke|complete|generate|predict|chat)\s*\(|\b(?:openai|anthropic|llm|model|chain|agent|completion)\w*\s*\.\s*\w+\s*\(/i;

/** A value glued into its own field is not a value glued into a prompt. */
const assignsToItself = (statement: string, value: string): boolean => {
  const eq = statement.indexOf('=');
  if (eq < 0) return false;
  const target = statement.slice(0, eq).trim();
  return target.length > 0 && (target === value.trim() || value.trim().startsWith(target));
};

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

/**
 * Every source as one pattern, for the cheap question asked first - with the leading `\w*` of each
 * one taken off, because for a yes-or-no question it is not only useless but most of the cost.
 *
 * Six of the eight patterns open with `\w*`, which is there so the reported source reads
 * `issue.body` rather than `sue.body` when the variable is `myIssue`. For *whether a match exists*
 * it changes nothing: any text matching `\w*issue\w*\s*\.\s*body` also matches
 * `issue\w*\s*\.\s*body` starting further along. What it does do is make the engine try `\w*` at
 * every position in the file and backtrack, and a CPU profile of `tewip agent` on n8n put this one
 * regex at 6.3 of 37 seconds - the second-largest cost in the command, inside the gate that was
 * added to make this check cheap in the first place.
 *
 * Derived from SOURCES rather than written out again, so it cannot drift from the patterns it is
 * the gate for; the test beside this asserts the two agree on every shape the scan claims.
 */
export const ANY_SOURCE = new RegExp(
  SOURCES.map((s) => `(?:${s.re.replace(/^\\w\*/, '').replace(/^\(\?:await\\s\+\)\?/, '')})`).join('|'),
);

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
    // A body window rather than the statement: the framework shapes put the strong signal beside
    // the weak one - `messages:` in the same call as `content:`, or an `.invoke(` on the next line.
    const body = text.slice(Math.max(0, at - 3000), at + 3000);
    // The statement, and deliberately not the body window used for tools.
    //
    // A window was the first attempt and it failed on the file it was written for. n8n's
    // `llm-step-display.ts` is 338 lines of code about displaying LLM steps, so three thousand
    // characters either side of anything in it contain `messages:`, `prompt` and `role:` belonging
    // to entirely unrelated code - and the formatter building the label `[tool-result: x]` was
    // reported again. The decoy in eval/injection-recall.ts said it was fixed, because the decoy
    // was one function with nothing around it. Every documented framework shape keeps its strong
    // signal inside the same statement as the glue, which is what makes the narrower test the
    // right one rather than merely the stricter one.
    if (WEAK_SINK.test(prompt[0]) && !A_MODEL_IS_HERE.test(statement)) continue;
    const line = text.slice(0, at).split(NL).length;
    // Tools in the same body: looked for from the start of the enclosing function rather than the
    // whole file, so a tool list in one handler does not arm a prompt built in another.
    const withTools = TOOLS_HERE.test(body);

    // Directly: the fetched value is written inside the prompt string itself.
    for (const { re, origin } of SOURCES) {
      const hit = new RegExp(re).exec(statement);
      if (!hit) continue;
      const how = gluedIn(statement, hit[0]);
      if (!how || assignsToItself(statement, hit[0])) continue;
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
        withTools,
        evidence: statement.replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  // One finding per flow a reader can see, however many ways the scan arrived at it.
  //
  // `seen` keys the variable route by where the assignment was, so a value assigned from the same
  // source twice - `message.content = (message.content ? message.content + "\n" : "") + content`,
  // which is real n8n code - produced two keys and two findings that were identical in every
  // field. The report printed the same file, line, source and route twice, which reads as two
  // problems. Only findings alike in all of those are collapsed: a value that reaches one prompt
  // both directly and through a variable keeps both lines, because those are two routes somebody
  // actually wrote.
  const once = new Map<string, PromptFlow>();
  for (const flow of found) once.set(`${flow.file}:${flow.line}:${flow.source}:${flow.through}`, flow);
  return [...once.values()];
}
