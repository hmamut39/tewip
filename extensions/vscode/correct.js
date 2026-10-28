// Telling Tewip it was wrong, from the editor.
//
// The extension shipped `learn` - "what your corrections say" - and no way to make a correction.
// So the one button that reports on disagreements could only ever answer "Nothing yet: nobody has
// corrected anything here", and its own text then told the reader to go and type
// `tewip correct diagnosis "<test>" TIMING "why"` in a terminal. A feedback loop with the input
// left in another application is not a loop, and the half that was shipped is the half that is
// useless without the other.
//
// It is the correction, not the report, that makes Tewip worth keeping: a tool that is wrong and
// stays wrong gets switched off. So this is the command that earns the rest of them.
const vscode = require('vscode');
const { runTewip, workspaceDir } = require('./run.js');

/** What Tewip decides, and what you may tell it instead. Mirrors engine/learn/verdicts.ts. */
const KINDS = [
  {
    id: 'diagnosis',
    label: 'A diagnosis - why a test failed',
    what: 'Which test? Paste its name, or enough of it to be unambiguous',
    verdicts: ['REAL_BUG', 'LOCATOR_DRIFT', 'TIMING', 'ENV', 'TEST_DATA'],
  },
  { id: 'flaky', label: 'A flaky verdict - what to do about a flaky test', what: 'Which test?', verdicts: ['quarantine', 'fix-now', 'watch', 'release'] },
  { id: 'security', label: 'A security finding', what: 'Which finding? Paste the file and line, or the rule', verdicts: ['real-risk', 'not-reachable', 'noise', 'accepted'] },
  { id: 'design', label: 'A design difference', what: 'Which difference?', verdicts: ['real', 'not-a-difference'] },
  { id: 'build', label: 'A refused build', what: 'Which build or project?', verdicts: ['belongs-here', 'not-this-project'] },
  { id: 'review', label: 'A review verdict - whether the tests cover a change', what: 'Which change or file?', verdicts: ['covers', 'does-not-cover'] },
];

/**
 * Asks the four questions `tewip correct` takes, then runs it.
 *
 * Every step can be escaped out of, and escaping writes nothing - a correction is stored and
 * answered with from then on, so a half-finished one is worse than none. The reason is the only
 * optional part, and it is asked for anyway: `learn` reads the reasons back to find the pattern
 * behind a run of corrections, and a correction with no reason tells it nothing.
 */
function correctSomething() {
  return async () => {
    const cwd = workspaceDir();
    if (!cwd) {
      vscode.window.showWarningMessage('Tewip: open the project folder first - a correction is stored with the project it is about.');
      return;
    }

    const kind = await vscode.window.showQuickPick(
      KINDS.map((k) => ({ label: k.label, id: k.id })),
      { title: 'Tewip was wrong about what?', ignoreFocusOut: true },
    );
    if (!kind) return;
    const chosen = KINDS.find((k) => k.id === kind.id);

    const what = await vscode.window.showInputBox({ title: chosen.what, ignoreFocusOut: true });
    if (!what?.trim()) return;

    const verdict = await vscode.window.showQuickPick(chosen.verdicts, { title: 'What is it really?', ignoreFocusOut: true });
    if (!verdict) return;

    const why = await vscode.window.showInputBox({
      title: 'Why? (optional, and the part that makes the pattern readable later)',
      placeHolder: 'e.g. the fixture has stale prices',
      ignoreFocusOut: true,
    });
    // Escape here means "no reason", not "cancel": the three answers that matter are already given.
    const args = ['correct', chosen.id, what.trim(), verdict, ...(why?.trim() ? [why.trim()] : [])];

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Tewip is recording your correction…' }, async () => {
      try {
        const out = await runTewip(args, cwd);
        // Short and definite, so it is read. `learn` is where the accumulated picture lives.
        vscode.window.showInformationMessage(`Tewip: ${out.trim().split('\n')[0]}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Tewip: ${error.message}`);
      }
    });
  };
}

module.exports = { correctSomething, KINDS };
