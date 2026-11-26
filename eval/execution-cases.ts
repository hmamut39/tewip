// The cases for eval/execution-recall.ts: the model’s answer, run as code (OWASP ASI05).
//
// Split from the harness next door when it crossed this project’s 300-line rule. The cases live
// apart from the measuring on purpose: what each one *is* can then be read without scrolling past
// how it is counted, and a case added here cannot quietly change the arithmetic.
//
// Ground truth is three published CVEs rather than an opinion about what looks risky:
//
//   - LangChain’s `PALChain`, before 0.0.236 - the model’s Python, run with `exec`
//     (CVE-2023-36258).
//   - LangChain’s `LLMMathChain`, through 0.0.131 - a prompt injection reaching arbitrary code
//     execution "via the Python exec method" (CVE-2023-29374, CVSS 9.8).
//   - Vanna.AI’s `ask(visualize=True)` - the Plotly code is generated from the model’s answer and
//     run with `exec`, so a crafted question put the attacker’s code at the top of the script
//     (CVE-2024-5565). The vendor’s hardening guide answers it by saying to run that function in a
//     sandbox, which is why a sandbox at the call site appears below as a decoy rather than a find.
//
// The rest are the same shape written in the SDKs people use now. The decoys are the forms that
// must stay quiet - a constant, an HTTP value that belongs to a different check, an argv that no
// shell parses, a safe YAML loader, a sandbox, a person asked first, and the model’s answer sitting
// in scope beside a sink it never reaches.

const NL = String.fromCharCode(10);
const py = (...lines: string[]) => lines.join(NL);

export interface Case {
  name: string;
  file: string;
  code: string;
  /** Whether the model's answer reaches something that runs it. */
  runs: boolean;
  /**
   * False for a shape this project refuses to follow by design, named here rather than left out.
   *
   * It is scored apart from the recall figure for the same reason the goal-hijack harness scores
   * its unreachable case apart: counting a deliberate refusal as a miss would make the number
   * argue for removing the refusal, and counting it as a find would be a lie.
   */
  reachable: boolean;
  why: string;
}

export const CASES: Case[] = [
  // ---- the published cases ----
  {
    name: 'LangChain PALChain, CVE-2023-36258: the model’s Python, run with exec',
    file: 'pal.py',
    code: py(
      'def run(self, question: str) -> str:',
      '    code = self.llm_chain.predict(question=question, stop=[self.stop])',
      '    local_vars = {}',
      '    exec(code, {}, local_vars)',
      '    return local_vars["solution"]',
    ),
    runs: true,
    reachable: true,
    why: 'the chain returns Python and the next statement runs it',
  },
  {
    name: 'Vanna.AI, CVE-2024-5565: generated Plotly code, run with exec',
    file: 'vanna_plot.py',
    code: py(
      'def get_plotly_figure(self, question: str, df):',
      '    plotly_code = self.generate_plotly_code(question=question, df_metadata=str(df.dtypes))',
      '    ldict = {"df": df, "px": px, "go": go}',
      '    exec(plotly_code, globals(), ldict)',
      '    return ldict["fig"]',
    ),
    runs: true,
    reachable: true,
    why: 'a crafted question puts the attacker’s code at the top of the generated script',
  },
  {
    name: 'LangChain LLMMathChain, CVE-2023-29374: the answer split out of the model’s text first',
    file: 'llm_math.py',
    code: py(
      'def _call(self, inputs):',
      '    llm_output = self.llm_chain.predict(question=inputs["question"], stop=["```output"])',
      '    expression = llm_output.split("```python")[1].strip()',
      '    return eval(expression)',
    ),
    runs: true,
    reachable: false,
    why: 'two hops - the model’s answer into a variable, then a slice of that variable into eval - which this project refuses to follow everywhere it reads a flow',
  },
  // ---- the same shape in the SDKs people use now ----
  {
    name: 'an OpenAI completion, handed to a shell',
    file: 'runner.ts',
    code: py(
      'async function doIt(task: string) {',
      '  const completion = await client.chat.completions.create({ model: "gpt-5", messages: [{ role: "user", content: task }] });',
      '  const cmd = completion.choices[0].message.content;',
      '  return execSync(cmd).toString();',
      '}',
    ),
    runs: true,
    reachable: true,
    why: 'execSync takes a command line, so a shell parses whatever the model wrote',
  },
  {
    name: 'the same completion read with optional chaining, which is how TypeScript reads JSON',
    file: 'optional.ts',
    code: py(
      'async function doIt(task: string) {',
      '  const json = (await res.json()) as Reply;',
      '  const cmd = json.choices?.[0]?.message?.content;',
      '  if (!cmd) throw new Error("model returned no content");',
      '  return execSync(cmd).toString();',
      '}',
    ),
    runs: true,
    reachable: true,
    why: 'the spelling Tewip’s own model client uses, and the one the first draft of this check could not see',
  },
  {
    name: 'an Anthropic message, compiled with new Function',
    file: 'compile.ts',
    code: py(
      'async function build(spec: string) {',
      '  const msg = await anthropic.messages.create({ model: "claude-opus-5", messages: [{ role: "user", content: spec }] });',
      '  const fn = new Function(msg.content[0].text);',
      '  return fn();',
      '}',
    ),
    runs: true,
    reachable: true,
    why: 'new Function is eval with a different name on it',
  },
  {
    name: 'the Vercel AI SDK’s destructured text, evaluated',
    file: 'vercel.ts',
    code: py(
      'export async function calc(prompt: string) {',
      '  const { text } = await generateText({ model: openai("gpt-5"), prompt });',
      '  return eval(text);',
      '}',
    ),
    runs: true,
    reachable: true,
    why: 'the quickstart shape, destructured, which is how most TypeScript agents are written',
  },
  {
    name: 'the OpenAI Responses API, handed to os.system',
    file: 'shell.py',
    code: py(
      'def do(task: str) -> None:',
      '    resp = client.responses.create(model="gpt-5", input=task)',
      '    os.system(resp.output_text)',
    ),
    runs: true,
    reachable: true,
    why: 'written straight into the call, with no variable in between',
  },
  {
    name: 'an LLM answer into subprocess with shell=True',
    file: 'sub.py',
    code: py(
      'def deploy(goal: str) -> None:',
      '    answer = llm.invoke(goal)',
      '    subprocess.run(answer.content, shell=True, check=True)',
    ),
    runs: true,
    reachable: true,
    why: 'shell=True is what turns an argument into a command line',
  },
  {
    name: 'a plan from a chain, loaded by a YAML loader that constructs objects',
    file: 'plan.py',
    code: py(
      'def load_plan(goal: str):',
      '    plan = chain.run(goal)',
      '    return yaml.load(plan, Loader=yaml.Loader)',
    ),
    runs: true,
    reachable: true,
    why: 'the default loader builds any Python object the document names, which is code execution by another route',
  },
  // ---- the forms that must stay quiet ----
  {
    name: 'DECOY: Vanna’s own hardening guidance - the same code, in a sandbox',
    file: 'vanna_safe.py',
    code: py(
      'def get_plotly_figure(self, question: str, df):',
      '    plotly_code = self.generate_plotly_code(question=question, df_metadata=str(df.dtypes))',
      '    with AsyncSandbox(timeout=30) as box:',
      '        exec(plotly_code, box.globals, box.locals)',
      '    return box.result',
    ),
    runs: false,
    reachable: true,
    why: 'the control OWASP names and the vendor asked for - accusing this would accuse the project that read the advisory',
  },
  {
    name: 'DECOY: a person asked before the command runs',
    file: 'confirm.ts',
    code: py(
      'async function run(task: string) {',
      '  const { text } = await generateText({ model: openai("gpt-5"), prompt: task });',
      '  if (!(await confirm("Run this command?"))) return null;',
      '  return execSync(text).toString();',
      '}',
    ),
    runs: false,
    reachable: true,
    why: 'the other control OWASP names for this risk',
  },
  {
    name: 'DECOY: the model’s answer as one argument of an argv',
    file: 'argv.py',
    code: py(
      'def commit(goal: str) -> None:',
      '    answer = llm.invoke(goal)',
      '    subprocess.run(["git", "commit", "-m", answer.content], check=True)',
    ),
    runs: false,
    reachable: true,
    why: 'no shell parses an argv, so a message full of semicolons is a message full of semicolons',
  },
  {
    name: 'DECOY: the same plan, through a safe YAML loader',
    file: 'plan_safe.py',
    code: py(
      'def load_plan(goal: str):',
      '    plan = chain.run(goal)',
      '    return yaml.load(plan, Loader=yaml.SafeLoader)',
    ),
    runs: false,
    reachable: true,
    why: 'SafeLoader is the documented way to say no to constructors',
  },
  {
    name: 'DECOY: eval of a constant, in a file that also calls a model',
    file: 'const.ts',
    code: py(
      'export async function ask(prompt: string) {',
      '  const { text } = await generateText({ model: openai("gpt-5"), prompt });',
      '  const limit = eval("24 * 60 * 60");',
      '  return { text, limit };',
      '}',
    ),
    runs: false,
    reachable: true,
    why: 'a sink in the same body that the model’s answer never reaches - the false finding that matters most, because it is the commonest arrangement in real code',
  },
  {
    name: 'DECOY: an HTTP value reaching eval, which is the other checker’s case',
    file: 'http.ts',
    code: py(
      'app.get("/calc", async (req, res) => {',
      '  const { text } = await generateText({ model: openai("gpt-5"), prompt: "describe" });',
      '  const value = eval(req.query.expr);',
      '  res.json({ text, value });',
      '});',
    ),
    runs: false,
    reachable: true,
    why: 'a real defect and a different one: engine/taint/flow.ts reports request values reaching a sink, and reporting it here too would make this finding mean nothing',
  },
  {
    name: 'DECOY: the answer returned from one function, run in another',
    file: 'twobodies.ts',
    code: py(
      'async function plan(task: string) {',
      '  const text = await generateText({ model: openai("gpt-5"), prompt: task });',
      '  return text;',
      '}',
      '',
      'function runIt(text: string) {',
      '  return execSync(text).toString();',
      '}',
    ),
    runs: false,
    reachable: true,
    why: 'one function body, no call graph - the refusal every flow check here shares, stated rather than guessed at. The same name in both bodies on purpose: with different names this decoy would be quiet because the sink never mentions the variable, and would prove nothing about the boundary',
  },
];
