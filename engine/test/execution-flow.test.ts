// OWASP ASI05, Unexpected Code Execution: what the model wrote back, run as code.
//
// `eval/execution-recall.ts` measures this against three published CVEs - LangChain's PALChain
// (CVE-2023-36258), its LLMMathChain (CVE-2023-29374) and Vanna.AI's generated Plotly code
// (CVE-2024-5565) - and `confidence-is-current.test.ts` re-derives that figure. These are the
// behaviours underneath it, and most of them are about staying quiet: the two controls OWASP names
// for this risk both appear here as cases that must produce nothing. Phase 226.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executionFlows, ANY_MODEL, SOURCES } from '../agent/execution-flow.ts';
import { blank } from '../agent/source-text.ts';

const NL = String.fromCharCode(10);
const run = (file: string, ...lines: string[]) => {
  const code = lines.join(NL);
  return executionFlows(file, code, blank(code, file.endsWith('.py')));
};

describe('the model’s answer, run as code', () => {
  it('reads the published shape: a chain’s Python, handed to exec', () => {
    const got = run('pal.py', 'def go(self, q):', '    code = self.llm_chain.predict(question=q)', '    exec(code, {}, {})');
    assert.equal(got.length, 1);
    assert.equal(got[0].sink, 'exec(');
    assert.equal(got[0].through, 'the variable `code`');
    assert.match(got[0].origin, /chain or an LLM call/);
    assert.match(got[0].evidence, /CVE-2023-36258/, 'the published case is quoted, so the reader can check it');
  });

  it('reads an optionally-chained completion, which is how TypeScript reads a JSON reply', () => {
    // Tewip's own model client reads `json.choices?.[0]?.message`. The first draft of this check
    // could not see that, so it was blind to the commonest spelling in the language most agents are
    // written in - and it took running it against this repository to notice.
    const got = run('t.ts', 'async function f() {', '  const cmd = json.choices?.[0]?.message?.content;', '  return execSync(cmd);', '}');
    assert.equal(got.length, 1, 'optional chaining at every step still reaches the shell');
    assert.match(got[0].runs, /handed to a shell/);
  });

  it('says plainly that node:vm is not a security boundary', () => {
    // A reader who sees `vm` and relaxes has been misled by the module's name. Node's own
    // documentation says it is not a security mechanism, so the finding says so too.
    const got = run('vm.ts', 'async function f(p) {', '  const { text } = await generateText({ model, prompt: p });', '  return vm.runInNewContext(text);', '}');
    assert.equal(got.length, 1);
    assert.match(got[0].runs, /not a security boundary/);
  });

  // ---- the two controls OWASP names, which must never be reported ----

  it('says nothing where the generated code runs in a sandbox', () => {
    // Vanna's own hardening guide, written after CVE-2024-5565, tells callers to do exactly this.
    // A check that reports the project which read the advisory is worse than no check.
    const got = run(
      'safe.py',
      'def fig(self, q, df):',
      '    plotly_code = self.generate_plotly_code(question=q)',
      '    with AsyncSandbox(timeout=30) as box:',
      '        exec(plotly_code, box.globals)',
    );
    assert.deepEqual(got, []);
  });

  it('says nothing where a person is asked first', () => {
    const got = run(
      'ask.ts',
      'async function f(task) {',
      '  const { text } = await generateText({ model, prompt: task });',
      '  if (!(await confirm("Run this?"))) return null;',
      '  return execSync(text);',
      '}',
    );
    assert.deepEqual(got, []);
  });

  // ---- the shapes that are not execution, however much they look like it ----

  it('knows an argv from a command line', () => {
    const argv = run('argv.py', 'def c(g):', '    answer = llm.invoke(g)', '    subprocess.run(["git", "commit", "-m", answer.content])');
    assert.deepEqual(argv, [], 'no shell parses an argv, so a message full of semicolons is a message');
    const shell = run('shell.py', 'def c(g):', '    answer = llm.invoke(g)', '    subprocess.run(answer.content, shell=True)');
    assert.equal(shell.length, 1, 'shell=True is what turns the argument into a command line');
  });

  it('knows a YAML loader that refuses constructors from one that does not', () => {
    const unsafe = run('y.py', 'def p(g):', '    plan = chain.run(g)', '    return yaml.load(plan, Loader=yaml.Loader)');
    assert.equal(unsafe.length, 1);
    assert.deepEqual(run('y.py', 'def p(g):', '    plan = chain.run(g)', '    return yaml.load(plan, Loader=yaml.SafeLoader)'), []);
  });

  it('does not report a sink the model’s answer never reaches', () => {
    // The false finding that would arrive first, because this is the commonest arrangement in real
    // code: a model is called somewhere in the function, and an `eval` of something else sits in it.
    const got = run('const.ts', 'async function f(p) {', '  const { text } = await generateText({ model, prompt: p });', '  const limit = eval("24 * 60 * 60");', '  return { text, limit };', '}');
    assert.deepEqual(got, []);
  });

  it('will not join a model call in one function to a sink in another', () => {
    // The same name in both bodies, which is the only version of this fixture that tests what it
    // says. Written first with `text` in one function and `cmd` in the other, it passed because the
    // sink did not mention the variable at all - so sabotaging the body check changed nothing and
    // the test was guarding a rule it never reached. A parameter that happens to share a name with
    // a variable elsewhere is also the realistic shape.
    const got = run(
      'two.ts',
      'async function plan(t) {',
      '  const text = await generateText({ model, prompt: t });',
      '  return text;',
      '}',
      '',
      'function runIt(text) {',
      '  return execSync(text);',
      '}',
    );
    assert.deepEqual(got, [], 'one body, no call graph - the refusal every flow check here shares');
  });

  it('leaves a deterministic code generator alone', () => {
    // n8n ships `generateCode(tree, json, graph)`, which walks an AST and emits TypeScript with no
    // model anywhere near it, and it is the only file in 36,323 of the corpus holding both a source
    // this check once recognised and an execution sink. It went unreported because it is a test
    // file and the scan skips those, which is luck rather than design. `generate` plus a noun is
    // what every compiler and ORM in the world calls its own code path.
    const got = run('codegen.ts', 'function emit(tree, json, graph) {', '  const out = generateCode(tree, json, graph);', '  return new Function(out);', '}');
    assert.deepEqual(got, []);
  });

  it('reads a string literal as a string, not as an expression', () => {
    // `blanked.calls` rather than the raw source. A worked example inside a comment is not code
    // either, and the same blanking is what keeps it quiet.
    const got = run('lit.py', 'def f(g):', '    answer = llm.invoke(g)', '    # exec(answer.content) would be the bug', '    exec("print(1)")');
    assert.deepEqual(got, []);
  });

  // ---- the gate, which exists for speed and must not change the answer ----

  it('holds its cheap first question to the patterns it is the gate for', () => {
    // ANY_MODEL is derived from SOURCES so it cannot drift, and the derivation strips a leading
    // `\w*`. Both of those are only safe if every shape SOURCES matches also passes the gate.
    for (const { re } of SOURCES) {
      const example = re
        .replace(/\\w\*/g, 'my')
        .replace(/\\w\+/g, 'x')
        .replace(/\\s\*/g, '')
        .replace(/\\s\+/g, ' ')
        .replace(/\\\?\?/g, '')
        .replace(/\(\?:\\\?\\\.\)\?/g, '')
        .replace(/\\\[\[\^\\\]\]\*\\\]/g, '[0]')
        .replace(/\\\(\[\^\)\]\*\\\)/g, '(x)')
        .replace(/\\\./g, '.')
        .replace(/\\b/g, '')
        .replace(/\(\?:await\\s\+\)\?/g, '')
        .replace(/\(\?:([^|)]+)\|[^)]*\)/g, '$1');
      assert.match(example, new RegExp(re), `this test built an example its own pattern rejects: ${example}`);
      assert.ok(ANY_MODEL.test(example), `${example} matches a source pattern and does not pass the gate, so the gate hides a real flow`);
    }
  });
});
