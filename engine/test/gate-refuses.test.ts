// OWASP ASI09, Human-Agent Trust Exploitation: a gate that cannot say no.
//
// `eval/refusal-recall.ts` measures this and `confidence-is-current.test.ts` re-derives the figure.
// These are the behaviours underneath it, and most of them are about staying quiet - because the
// first draft reported 54 gates across the corpus and every one of them was a correct
// implementation. Each `it` below that begins "leaves" or "knows" is one of those, kept so the fix
// cannot be undone quietly. Phase 227.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toothlessGates } from '../agent/gate-refuses.ts';

const NL = String.fromCharCode(10);
const run = (file: string, ...lines: string[]) => toothlessGates(file, lines.join(NL));

describe('a gate that cannot say no', () => {
  it('reads a confirmation whose answer is thrown away', () => {
    const got = run('wipe.ts', 'async function f(db) {', '  await confirm("Delete all records? This cannot be undone.");', '  return db.deleteAll();', '}');
    assert.equal(got.length, 1);
    assert.equal(got[0].gate, 'confirm');
    assert.equal(got[0].why, 'its answer is thrown away where it is asked');
    // The question is quoted back, which is the whole evidence: it is what the person was shown.
    assert.equal(got[0].asked, 'Delete all records? This cannot be undone.');
  });

  it('reads an answer kept in a name that nothing reads again', () => {
    const got = run('refund.ts', 'async function f(id) {', '  const approved = await askHuman("Approve this refund?");', '  return payments.refund(id);', '}');
    assert.equal(got.length, 1);
    assert.equal(got[0].why, 'its answer is put in a name nothing reads again');
    // And the same code, with the name read, is not a finding.
    assert.deepEqual(
      run('refund.ts', 'async function f(id) {', '  const approved = await askHuman("Approve this refund?");', '  if (!approved) return null;', '  return payments.refund(id);', '}'),
      [],
    );
  });

  it('reads Python’s input() as a gate only when it asks permission', () => {
    assert.equal(run('a.py', 'def wipe(p):', '    input("Are you sure? [y/N] ")', '    shutil.rmtree(p)').length, 1);
    // `input(` is a builtin and most of its uses are not gates, so the prompt has to say so. This
    // decoy discards its answer, which is what makes it a test of the prompt rather than of the
    // rule next door: written as `path = input("path: ")`, it was quiet because `path` is read on
    // the following line, and removing the prompt test changed nothing.
    assert.deepEqual(run('b.py', 'def show():', '    input("Press Enter to see the report...")', '    print(report())'), []);
    // And the same shape where the question does ask permission is a finding.
    assert.equal(run('c.py', 'def show():', '    input("Overwrite the report? ")', '    print(report())').length, 1);
  });

  // ---- the shapes this check reported wrongly on real code, each one now held here ----

  it('leaves LangGraph’s interrupt alone, because calling it is the gate', () => {
    // `interrupt` suspends the graph. Nothing continues until a person resumes it, so the gate
    // refuses by not being resumed, whatever the code does with the return value.
    assert.deepEqual(run('g.py', 'def review(state):', '    interrupt({"question": "Approve this plan?"})', '    return act(state)'), []);
  });

  it('knows a gate behind a receiver chain', () => {
    // Fourteen of the findings on n8n were this and nothing else: a correct gate, accused because
    // the character before the call was a `.`.
    assert.deepEqual(run('r.ts', 'async function f(job) {', '  if (!(await this.jobService.getApproval(job))) return null;', '  return this.run(job);', '}'), []);
  });

  it('knows a gate whose answer goes to a callback', () => {
    // Discourse's dialog service and Ant Design's Modal both work this way: the yes branch is an
    // argument and nothing happens on no.
    assert.deepEqual(
      run('d.js', 'editTheme() {', '  this.dialog.confirm({', '    message: i18n("admin.customize.theme.edit_confirm"),', '    didConfirm: () => this.transitionToEditRoute(),', '  });', '}'),
      [],
    );
  });

  it('finds the callback past a long argument list, and says nothing about one it cannot read', () => {
    // nocodb's real `Modal.confirm` is one call of 1,900 characters with `async onOk()` at the end.
    // A reading window that gave up before the close paren made the handler invisible. The filler
    // has to be longer than that window or this tests nothing: at 40 lines the call still closed
    // inside it, so the overflow path was never reached and sabotaging it changed no answer.
    const filler = Array.from({ length: 40 }, (_, i) => `    option${i}: "value ${i} padding padding padding padding padding",`);
    assert.deepEqual(run('n.ts', 'const del = (t) => {', '  Modal.confirm({', '    title: t.title,', ...filler, '    async onOk() {', '      await deleteNow(t);', '    },', '  });', '};'), []);
    // And a call so long that its end is past the reading window is left alone for the other
    // reason: nothing is concluded from the part that could not be read.
    const huge = Array.from({ length: 200 }, (_, i) => `    option${i}: "value ${i} padding padding padding padding padding",`);
    assert.deepEqual(run('h.ts', 'const del = (t) => {', '  Modal.confirm({', '    title: t.title,', ...huge, '  });', '};'), []);
  });

  it('knows a gate wrapped across lines', () => {
    // n8n's node CLI. Reported twice while this read a line break as the start of a statement,
    // which left nothing in front of `confirm(` but indentation.
    assert.deepEqual(
      run(
        'c.ts',
        'async function disable(dir) {',
        '  const confirmed = await withCancelHandler(',
        '    confirm({',
        '      message: "Are you sure you want to disable cloud support?",',
        '    }),',
        '  );',
        '  if (!confirmed) return;',
        '  await update(dir);',
        '}',
      ),
      [],
    );
  });

  it('knows a private field in the receiver chain', () => {
    assert.deepEqual(
      run('p.js', 'async discard() {', '  const confirmed = await this.#dialog.confirm({ message: i18n("discard") });', '  if (confirmed) this.reset();', '}'),
      [],
    );
  });

  it('leaves a definition alone, in both languages', () => {
    // Saleor's `def confirm(...) -> Optional[PaymentTransaction]:`, where the return annotation sat
    // between the arguments and the colon that says "body follows".
    assert.deepEqual(
      run('g.py', 'def confirm(', '    payment: Payment,', '    manager: "PluginsManager",', ') -> Optional[PaymentTransaction]:', '    return manager.confirm_payment(payment)'),
      [],
    );
    assert.deepEqual(run('u.ts', 'export async function confirm(message: string): Promise<boolean> {', '  return MessageBox.confirm(message);', '}'), []);
  });

  it('does not find a gate that somebody wrote in a comment', () => {
    // The blanked text is what gets walked, and this is the case that proves it: a note about the
    // gate somebody means to add is not a gate, and reading the raw source would report it. The
    // string test below does not cover this - its verdict is the same either way.
    //
    // No colon in the comment, which this fixture had as `// TODO: await confirm(...)`. A `:` is
    // one of the characters that means the answer was used, so the line was quiet whichever text
    // was being read, and sabotaging the blanking changed nothing.
    assert.deepEqual(
      run('todo.ts', 'async function f(db) {', '  // we should await confirm("Delete all records?") somewhere here', '  return db.deleteAll();', '}'),
      [],
    );
  });

  it('reads a string as a string, not as structure', () => {
    // A bracket inside a string must not move a statement boundary, which is why the blanked text
    // is what gets walked.
    const got = run('s.ts', 'async function f(db) {', '  await confirm("Delete? (this { cannot } be undone)");', '  return db.deleteAll();', '}');
    assert.equal(got.length, 1, 'the brackets in the question are text, not a block');
  });
});
