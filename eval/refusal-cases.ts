// The cases for eval/refusal-recall.ts: a gate that cannot say no (OWASP ASI09).
//
// Ground truth is the shape each library documents for asking a person, which is the same basis
// eval/guard-recall.ts uses - those lines are what people copy. The gates that cannot refuse are
// the same shapes with the answer dropped.
//
// **Every decoy here is real code**, and that is the point of them. The first draft of this check
// reported 54 findings across the corpus and every single one was a correct implementation. Each
// round of reading them found another way a gate delivers its answer that the check did not know
// about, and each of those is now a case below, so the fix cannot be undone quietly:
//
//   - a receiver chain - `this.jobService.getApproval(job)` (n8n, 14 findings)
//   - a callback instead of a return value - `didConfirm:`, `async onOk()` (Discourse and nocodb,
//     10 findings)
//   - a gate wrapped across lines - `withCancelHandler(` + newline + `confirm({...})` (n8n)
//   - a private field in the chain - `this.#dialog.confirm(...)` (Discourse)
//   - a Python definition with a return annotation - `def confirm(...) -> Optional[X]:` (Saleor)
//   - an argument list too long to read to the end, where the handler lives past the window
//     (nocodb's `Modal.confirm`, 1,900 characters in one call)
//
// A gate is a *reassuring* finding to contradict. Telling somebody their approval step does
// nothing, when it works, is the kind of wrong that gets a check switched off - so the decoys
// outnumber the findings here on purpose.

const NL = String.fromCharCode(10);
const src = (...lines: string[]) => lines.join(NL);

export interface Case {
  name: string;
  file: string;
  code: string;
  /** Whether the person's answer can actually stop what happens next. */
  refuses: boolean;
  why: string;
}

export const CASES: Case[] = [
  // ---- gates that cannot refuse ----
  {
    name: 'a hand-written confirmation whose answer is dropped',
    file: 'wipe.ts',
    code: src(
      'export async function deleteEverything(db: Db) {',
      '  await confirm("Delete all records? This cannot be undone.");',
      '  return db.deleteAll();',
      '}',
    ),
    refuses: false,
    why: 'the question is asked, the person answers, and the delete happens either way',
  },
  {
    name: 'an approval kept in a name that nothing reads again',
    file: 'refund.ts',
    code: src(
      'export async function refund(id: string) {',
      '  const approved = await askHuman("Approve this refund?");',
      '  return payments.refund(id);',
      '}',
    ),
    refuses: false,
    why: 'the answer is stored and never looked at, which reads as a gate in a diff and is not one',
  },
  {
    name: 'Python’s input() as a confirmation, discarded',
    file: 'rmtree.py',
    code: src('def wipe(path):', '    input("Are you sure? [y/N] ")', '    shutil.rmtree(path)'),
    refuses: false,
    why: 'the commonest hand-written gate there is, and the commonest way to get it wrong',
  },
  {
    name: 'an awaited ask with no assignment and no condition',
    file: 'send.py',
    code: src('async def send_all(outbox):', '    await ask_user("Send to every customer? Really?")', '    await outbox.flush()'),
    refuses: false,
    why: 'awaiting it makes the prompt appear, which is what makes this convincing to a reader',
  },
  {
    name: 'an approval requested before a payment and then ignored',
    file: 'pay.ts',
    code: src(
      'async function pay(invoice: Invoice) {',
      '  requestApproval({ amount: invoice.total, reason: "vendor payment" });',
      '  return bank.transfer(invoice);',
      '}',
    ),
    refuses: false,
    why: 'the request is made and the transfer does not wait for it',
  },
  // ---- the documented correct forms, and the real code this check had accused ----
  {
    name: 'DECOY: the plain correct form, tested inline',
    file: 'ok.ts',
    code: src(
      'export async function deleteEverything(db: Db) {',
      '  if (!(await confirm("Delete all records?"))) return null;',
      '  return db.deleteAll();',
      '}',
    ),
    refuses: true,
    why: 'the answer decides, in the same expression that asks',
  },
  {
    name: 'DECOY: n8n’s node CLI - the gate wrapped across lines',
    file: 'cloud-support.ts',
    code: src(
      'async function disable(workingDir: string) {',
      '  const confirmed = await withCancelHandler(',
      '    confirm({',
      '      message: "Are you sure you want to disable cloud support?",',
      '      initialValue: false,',
      '    }),',
      '  );',
      '  if (!confirmed) {',
      '    onCancel("Cloud support unchanged");',
      '    return;',
      '  }',
      '  await updateEslintConfig(workingDir, false);',
      '}',
    ),
    refuses: true,
    why: 'real code, and reported twice while this check still read a line break as the start of a statement',
  },
  {
    name: 'DECOY: Discourse’s dialog service - the answer goes to a callback',
    file: 'theme.js',
    code: src(
      'editTheme() {',
      '  if (this.get("model.remote_theme.is_git")) {',
      '    this.dialog.confirm({',
      '      message: i18n("admin.customize.theme.edit_confirm"),',
      '      didConfirm: () => this.transitionToEditRoute(),',
      '    });',
      '  } else {',
      '    this.transitionToEditRoute();',
      '  }',
      '}',
    ),
    refuses: true,
    why: 'the yes branch is an argument, and nothing happens on no - a gate with teeth, written the way its library documents',
  },
  {
    name: 'DECOY: nocodb’s Modal.confirm - the handler sits past a long argument list',
    file: 'useTableNew.ts',
    code: src(
      'const deleteTable = (table: TableType) => {',
      '  Modal.confirm({',
      '    title: `${t("msg.info.deleteTableConfirmation")} : ${table.title}?`,',
      '    wrapClassName: "nc-modal-table-delete",',
      '    okText: t("general.yes"),',
      '    okType: "danger",',
      '    cancelText: t("general.no"),',
      '    width: 450,',
      `    // ${'filler to push the handler past a short reading window. '.repeat(30)}`,
      '    async onOk() {',
      '      await deleteTableNow(table);',
      '    },',
      '  });',
      '};',
    ),
    refuses: true,
    why: 'the real call is 1,900 characters, and a reading window that gave up before the end made the handler invisible',
  },
  {
    name: 'DECOY: Discourse again - a private field in the receiver chain',
    file: 'publish-state.js',
    code: src(
      'async discard() {',
      '  const confirmed = await this.#dialog.confirm({',
      '    message: i18n("discourse_workflows.discard_changes_confirmation"),',
      '  });',
      '  if (confirmed) {',
      '    this.reset();',
      '  }',
      '}',
    ),
    refuses: true,
    why: 'the `#` stopped the walk back over the receiver, so an assignment that is read two lines later was read as a discard',
  },
  {
    name: 'DECOY: n8n’s background runner - a gate behind two receivers',
    file: 'runner.ts',
    code: src(
      'async function step(job: Job) {',
      '  if (!(await this.jobService.getApproval(job))) {',
      '    return null;',
      '  }',
      '  return this.run(job);',
      '}',
    ),
    refuses: true,
    why: 'fourteen findings on n8n were this one shape - a correct gate accused for having a receiver',
  },
  {
    name: 'DECOY: Saleor - a definition, not a call',
    file: 'gateway.py',
    code: src(
      'def confirm(',
      '    payment: Payment,',
      '    manager: "PluginsManager",',
      '    channel_slug: str,',
      ') -> Optional[PaymentTransaction]:',
      '    return manager.confirm_payment(payment, channel_slug=channel_slug)',
    ),
    refuses: true,
    why: 'a function has no answer to throw away - it is the thing that produces one, and the return annotation is what hid this',
  },
  {
    name: 'DECOY: LangGraph’s interrupt, whose return value need not be read',
    file: 'graph.py',
    code: src('def review(state):', '    interrupt({"question": "Approve this plan?"})', '    return act(state)'),
    refuses: true,
    why: 'calling interrupt suspends the graph - nothing continues until a person resumes it, so the gate refuses by not being resumed',
  },
  {
    name: 'DECOY: an input() that is not asking permission',
    file: 'read.py',
    code: src('def load():', '    path = input("path: ")', '    return open(path).read()'),
    refuses: true,
    why: '`input(` is a builtin and most of its uses are not gates, so the prompt has to read like a question about permission',
  },
];
