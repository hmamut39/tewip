// OWASP ASI05, Unexpected Code Execution: what the model wrote back, run as code.
//
// ASI05 is the risk that an agent's own code-generation becomes the attacker's execution primitive.
// OWASP states it plainly - agentic systems often generate and execute code, and an attacker can
// escalate that into remote code execution - and places it as the agentic extension of LLM05,
// Improper Output Handling. The three published cases in this class are all one shape:
//
//   - LangChain's `LLMMathChain`, through 0.0.131: a prompt injection reached arbitrary code
//     execution "via the Python exec method" (CVE-2023-29374, CVSS 9.8).
//   - LangChain's `PALChain`, before 0.0.236: the model's Python, run with `exec`
//     (CVE-2023-36258).
//   - Vanna.AI's `ask(visualize=True)`: the Plotly code is generated from the model's answer and
//     run with `exec`, so a crafted question put the attacker's code at the top of the script
//     (CVE-2024-5565). The vendor's own hardening guide says to run that function in a sandbox,
//     which is the control this file looks for.
//
// In every one the model is the only thing standing between text somebody else could influence and
// a process on the machine, and a model is not a boundary. `prompt-flow.ts` next door reports the
// first half of that - untrusted text reaching the prompt - and this reports the second: the
// model's answer reaching something that runs it.
//
// How this differs from the command-injection flow in `taint/flow.ts`, which also finds a shell:
// that one's source is an HTTP request value, `req.query` and its siblings. This one's source is
// the model. They are different claims about different inputs, and neither finds the other's case.
//
// Three things this deliberately does not do:
//
//   - It does not report a tool whose documented job is to run code - a Python REPL, a shell tool.
//     That is a design decision somebody made on purpose, and the control for it is a sandbox,
//     which `guards.ts` already reports on for the project as a whole.
//   - It does not follow the model's answer across a function boundary. One named variable, one
//     body, the same refusal as every other flow check here.
//   - It says nothing about whether the generated code is *malicious*. The finding is that nothing
//     stands between the model's answer and the interpreter.
import { callArguments, sameBody } from '../taint/flow.ts';
import type { Blanked } from './source-text.ts';

const NL = String.fromCharCode(10);

export interface ExecutionFlow {
  file: string;
  line: number;
  /** The model's answer, quoted from the code. */
  source: string;
  /** Which model call it came from, in words a reader can check. */
  origin: string;
  /** The call that runs it, quoted. */
  sink: string;
  /** What happens to it there. */
  runs: string;
  /** Written straight into the call, or through a named variable. */
  through: string;
  evidence: string;
}

/**
 * Where a model's answer arrives.
 *
 * Narrow on purpose, and the omission worth stating is `response.content`. It is the commonest way
 * a model's answer is spelled and also the commonest way *every HTTP response in the world* is
 * spelled, so including it would make this check about `requests` and `axios` rather than about
 * models. What is here instead is either a shape only an SDK produces - OpenAI's
 * `choices[0].message.content`, Anthropic's `content[0].text`, the Responses API's `output_text` -
 * or a call whose verb says a model was asked.
 */
export const SOURCES: Array<{ re: string; origin: string }> = [
  // `\??\.` at every step, which is not decoration. Tewip's own model client reads
  // `json.choices?.[0]?.message` and then `message.content`, and the first draft of this pattern
  // could not see it - so the check was blind to the single commonest spelling in TypeScript, in a
  // language where reaching into a parsed JSON reply without optional chaining is the unusual
  // choice. Found by running this against this repository rather than by thinking about it.
  {
    re: String.raw`\w+\s*\??\.\s*choices\s*(?:\?\.)?\s*\[[^\]]*\]\s*\??\.\s*message\s*\??\.\s*content`,
    origin: 'the model’s answer, from an OpenAI-shaped chat completion',
  },
  {
    re: String.raw`\w+\s*\??\.\s*content\s*(?:\?\.)?\s*\[[^\]]*\]\s*\??\.\s*text`,
    origin: 'the model’s answer, from an Anthropic-shaped message',
  },
  { re: String.raw`\w+\s*\??\.\s*output_text\b`, origin: 'the model’s answer, from the OpenAI Responses API' },
  {
    // LangChain and everything shaped like it: the receiver says what was asked.
    re: String.raw`\w*(?:llm|LLM|[Cc]hain|[Aa]gent|[Cc]hat|[Cc]ompletion)\w*\s*\.\s*(?:invoke|predict|predict_messages|run|call|complete|generate)\s*\([^)]*\)`,
    origin: 'the model’s answer, returned by a chain or an LLM call',
  },
  {
    // A method whose name is the question. Vanna's `submit_prompt` is this shape, and so is every
    // project that wrapped its own model call in a helper rather than inlining the SDK.
    //
    // Every name here contains a word that means a model - `llm`, `prompt` - or is the exact method
    // a published advisory names. `generate_code` and `generateCode` were here and are the reason
    // for the rule: n8n ships a deterministic `generateCode(tree, json, graph)` that walks an AST
    // and emits TypeScript, with no model anywhere near it, and it is **the only file in 36,323 of
    // the corpus that holds both a source this check recognises and an execution sink**. It went
    // unreported because it is a test file and the scan skips those, which is luck rather than
    // design. `generate` plus a noun is what every compiler, emitter and ORM in the world calls its
    // own code path.
    re: String.raw`\b(?:self\s*\.\s*)?(?:submit_prompt|submitPrompt|ask_llm|askLlm|call_llm|callLlm|llm_call|llmCall|llm_complete|complete_prompt|completePrompt|prompt_model|promptModel|generate_plotly_code)\s*\([^)]*\)`,
    origin: 'the model’s answer, from a call named for asking one',
  },
  {
    re: String.raw`(?:await\s+)?(?:generateText|generateObject|streamText)\s*\([^)]*\)`,
    origin: 'the model’s answer, from the Vercel AI SDK',
  },
];

/** The cheap question asked once per file, before any of the work below. */
export const ANY_MODEL = new RegExp(SOURCES.map((s) => `(?:${s.re.replace(/^\\w\*/, '').replace(/^\(\?:await\\s\+\)\?/, '')})`).join('|'));

/**
 * Something that runs what it is given.
 *
 * `needsShell` marks the two calls that are only a shell when asked to be: `subprocess.run` with a
 * list and no `shell=True` is an argv, and an argv is not parsed by anything. Reporting those would
 * put this check's name on the most common *correct* way to run a command.
 *
 * `safeIf` is the same idea for deserialisation. `yaml.load` runs a constructor named in the
 * document; `yaml.load(text, Loader=SafeLoader)` is the documented way to say no.
 */
const SINKS: Array<{ re: string; runs: string; needsShell?: boolean; safeIf?: RegExp }> = [
  { re: String.raw`(?<![.\w])eval\s*\(`, runs: 'evaluated as code' },
  { re: String.raw`(?<![.\w])exec\s*\(`, runs: 'executed as code' },
  { re: String.raw`(?<![.\w])compile\s*\(`, runs: 'compiled, which is a step from running' },
  { re: String.raw`(?<![.\w])__import__\s*\(`, runs: 'imported by a name the model chose' },
  { re: String.raw`\bnew\s+Function\s*\(`, runs: 'compiled into a function and called' },
  {
    // Node's `vm` is not a sandbox and its own documentation says so in those words. A reader who
    // sees it and relaxes has been misled by the module's name, so the finding says it outright.
    re: String.raw`\bvm\s*\.\s*run(?:InNewContext|InThisContext|InContext)\s*\(|\bnew\s+vm\s*\.\s*Script\s*\(`,
    runs: 'run through node:vm, which is not a security boundary - its own documentation says so',
  },
  { re: String.raw`\bos\s*\.\s*(?:system|popen)\s*\(`, runs: 'handed to a shell' },
  { re: String.raw`\bexecSync\s*\(|\bchild_process\s*\.\s*exec\s*\(|\bcp\s*\.\s*exec\s*\(`, runs: 'handed to a shell' },
  { re: String.raw`\bsubprocess\s*\.\s*(?:run|call|check_output|check_call|Popen)\s*\(`, runs: 'handed to a shell', needsShell: true },
  { re: String.raw`\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(`, runs: 'handed to a shell', needsShell: true },
  { re: String.raw`\bpickle\s*\.\s*loads?\s*\(`, runs: 'unpickled, which runs code named in the data while loading' },
  {
    re: String.raw`\byaml\s*\.\s*(?:load|unsafe_load|full_load)\s*\(`,
    runs: 'loaded as YAML by a loader that can construct any object named in it',
    safeIf: /SafeLoader|safe_load|BaseLoader/,
  },
];

/** A shell asked for explicitly, which is what turns an argv into a command line. */
const SHELL_ASKED = /\bshell\s*[:=]\s*(?:True|true|1)\b/;

/**
 * Somewhere the generated code cannot reach this machine.
 *
 * Every name belongs to a thing whose whole job is that, which is the same rule `guards.ts` uses
 * for the `sandboxed` guard and for the same reason: the bare word `sandbox` is a payments mode, an
 * AWS account name and half the test fixtures ever written, and a wrong finding here would accuse
 * the correct implementation. Vanna's own hardening guide, written after CVE-2024-5565, tells
 * callers to do exactly this - so a project that did it is the one that read the advisory.
 */
const SANDBOX = new RegExp(
  String.raw`\b(?:e2b|e2b_code_interpreter|AsyncSandbox|ACADynamicSessionsCodeExecutor|RestrictedPython|nsjail|firejail|bubblewrap|pyodide|gvisor|runsc|IsolatedVM)\b` +
    String.raw`|\bisolated-vm\b|\bSandbox\s*\.\s*create\b|\bnew\s+Sandbox\b|\b(?:docker|podman)\s+run\b|--network[= ]none|\bseccomp\b`,
  'i',
);

/**
 * A person, asked before it runs.
 *
 * The other control OWASP names for this risk, and the narrower list from `guards.ts`: a word that
 * means a gate, with a bracket or an equals after it so that `approved` in a sentence is not one.
 */
const ASKS_A_PERSON =
  /\binterrupt(?:_before|_after)?\s*[(=]|\b(?:confirm|confirm_\w+|confirmWith\w*|require_approval|requires_approval|requiresApproval|needs_approval|needsApproval|human_in_the_loop|humanInTheLoop|ask_human|askHuman|prompt_user|promptUser|await_approval|human_review)\s*[(=]/;

const lineOf = (text: string, at: number): number => text.slice(0, at).split(NL).length;
const quote = (text: string, at: number): string => {
  const from = text.lastIndexOf(NL, at) + 1;
  const to = text.indexOf(NL, at);
  return text.slice(from, to === -1 ? text.length : to).trim().slice(0, 160);
};

const WHY =
  'A model is not a boundary. OWASP calls this ASI05, Unexpected Code Execution, and the published cases are all this ' +
  'shape: LangChain’s LLMMathChain reached arbitrary execution through Python’s `exec` (CVE-2023-29374, 9.8), its ' +
  'PALChain ran the model’s Python the same way (CVE-2023-36258), and Vanna.AI generated Plotly code from the model’s ' +
  'answer and ran it, so a crafted question put the attacker’s code at the top of the script (CVE-2024-5565). The two ' +
  'controls OWASP names are a sandbox the generated code cannot reach out of, and a person for anything that matters. ' +
  'Neither is in this function.';

/**
 * The model's answer reaching something that runs it, in one function body.
 *
 * `blanked.calls` rather than the raw text, so a string literal is not read as an expression. That
 * is what keeps `eval("1 + 1")` quiet - a constant is not the model's answer, whatever it says -
 * and what keeps a worked example inside a comment from being reported as code. The indices line
 * up with the original, so every quote comes from the source a reader will open.
 */
export function executionFlows(file: string, text: string, blanked: Blanked): ExecutionFlow[] {
  const code = blanked.calls;
  if (!ANY_MODEL.test(code)) return [];

  // `name = <the model's answer>`, in both spellings, plus the Vercel SDK's destructure.
  const assigned: Array<{ name: string; at: number; source: string; origin: string }> = [];
  for (const { re, origin } of SOURCES) {
    for (const m of code.matchAll(new RegExp(String.raw`(?:(?:const|let|var)\s+)?(\w+)\s*=\s*(?:await\s+)?[^=\n]*?(` + re + String.raw`)`, 'g'))) {
      assigned.push({ name: m[1], at: m.index ?? 0, source: m[2], origin });
    }
    // `const { text: code } = await generateText(...)`, and `const { text } = ...`, which is how
    // the Vercel SDK's own quickstart is written and therefore how most TypeScript agents read.
    for (const m of code.matchAll(new RegExp(String.raw`\{\s*(?:text|object|content)\s*(?::\s*(\w+))?\s*[,}][^=\n]*=\s*(?:await\s+)?(` + re + String.raw`)`, 'g'))) {
      assigned.push({ name: m[1] ?? 'text', at: m.index ?? 0, source: m[2], origin });
    }
  }

  const found: ExecutionFlow[] = [];
  for (const sink of SINKS) {
    for (const hit of code.matchAll(new RegExp(sink.re, 'g'))) {
      const at = hit.index ?? 0;
      const args = callArguments(code, at);
      if (!args.all.trim()) continue;
      // The two sinks that are only dangerous when asked to be, and the loader that says no.
      if (sink.needsShell && !SHELL_ASKED.test(args.all)) continue;
      if (sink.safeIf?.test(args.all)) continue;
      // The controls OWASP names for this risk, in the function that runs the code. A window
      // rather than a parsed body: the sandbox is usually constructed a line or two above the call
      // that uses it, and the person is asked just before.
      const around = code.slice(Math.max(0, at - 800), at + 400);
      if (SANDBOX.test(around) || ASKS_A_PERSON.test(around)) continue;

      const line = lineOf(code, at);
      const evidence = quote(text, at);
      const one = (source: string, origin: string, through: string): void => {
        found.push({ file, line, source: source.replace(/\s+/g, ' ').slice(0, 80), origin, sink: hit[0].trim(), runs: sink.runs, through, evidence });
      };

      // Written straight into the call.
      let direct = false;
      for (const { re, origin } of SOURCES) {
        const inside = new RegExp(re).exec(args.all);
        if (!inside) continue;
        one(inside[0], origin, 'written straight into the call');
        direct = true;
        break;
      }
      if (direct) continue;

      // Through one variable, assigned from the model's answer earlier in the same body.
      for (const a of assigned) {
        if (a.at > at || !sameBody(code, a.at, at)) continue;
        if (!new RegExp(String.raw`\b${a.name}\b`).test(args.all)) continue;
        one(a.source, a.origin, `the variable \`${a.name}\``);
        break;
      }
    }
  }

  // One finding per place, however many patterns arrived at it: `exec(` and a `compile(` inside it
  // are one problem, and so is a value two source patterns both describe.
  const once = new Map<string, ExecutionFlow>();
  for (const flow of found) once.set(`${flow.file}:${flow.line}`, { ...flow, evidence: `${flow.evidence} — ${WHY}` });
  return [...once.values()];
}
