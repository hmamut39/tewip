// How an editor command is built. Which commands exist is extension.js; this is the machinery
// every one of them shares: show the Markdown, find the folder, find the open file, work out what
// branch a change is measured against, and say the same useful thing when Tewip is not installed.
//
// Split out when adding the commands the extension was missing took extension.js past the 300-line
// rule this project keeps. The seam is a real one rather than a convenience: this file changes when
// the way a command behaves changes, and extension.js changes when the catalogue does.
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const { runTewip, workspaceDir } = require('./run.js');

/** Shows Markdown output in a new editor with a rendered preview beside it. */
async function show(markdown) {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(doc, { preview: true });
  await vscode.commands.executeCommand('markdown.showPreviewToSide');
}

/**
 * Runs a verb in the open folder and shows what it prints. Everything except `explain` works on
 * the project as a whole, so they all share this: no arguments to collect, one progress message,
 * and the same advice when Tewip is not installed.
 */
function projectCommand({ verb, args = [], busy, needs }) {
  return async () => {
    const cwd = workspaceDir();
    if (!cwd) {
      vscode.window.showWarningMessage('Tewip: open the project folder first - this reads the project you are working in.');
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: busy }, async () => {
      try {
        await show(await runTewip([verb, ...args], cwd));
      } catch (error) {
        vscode.window.showErrorMessage(`Tewip: ${error.message}.${needs ? ` ${needs}` : ' Is it installed? `npm i -g tewip-ai`, or see the "tewip.path" setting.'}`);
      }
    });
  };
}

/** Asks for a line of text, then runs a verb with it in the open folder. */
function askThenRun({ verb, prompt, placeHolder, busy }) {
  return async () => {
    const cwd = workspaceDir();
    if (!cwd) {
      vscode.window.showWarningMessage('Tewip: open the project folder first - this reads the project you are working in.');
      return;
    }
    const typed = await vscode.window.showInputBox({ title: prompt, placeHolder, ignoreFocusOut: true });
    if (!typed?.trim()) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: busy }, async () => {
      try {
        await show(await runTewip([verb, typed.trim()], cwd));
      } catch (error) {
        vscode.window.showErrorMessage(`Tewip: ${error.message}. Is it installed? \`npm i -g tewip-ai\`, or see the "tewip.path" setting.`);
      }
    });
  };
}

/** owner/repo and branch of the workspace's git checkout, read from git itself. */
function gitInfo(cwd) {
  const git = (args) => new Promise((resolve) => execFile('git', args, { cwd }, (e, out) => resolve(e ? '' : out.trim())));
  return Promise.all([git(['remote', 'get-url', 'origin']), git(['branch', '--show-current'])]).then(([remote, branch]) => ({
    // Repository names may contain dots (acme/api.v2); only a trailing ".git" is dropped.
    repo: remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1],
    branch,
  }));
}

/**
 * The branch a change is measured against: what origin calls its default, else main, else master.
 * Asking the person for a git range every time is the kind of friction that stops a command being used.
 */
async function baseBranch(cwd) {
  const git = (args) => new Promise((resolve) => execFile('git', args, { cwd }, (e, out) => resolve(e ? '' : out.trim())));
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const named = head.split('/').pop();
  if (named) return named;
  for (const candidate of ['main', 'master', 'develop']) {
    if (await git(['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return 'main';
}

/** The file in the active editor, when there is one and it is a real file on disk. */
function openFile() {
  const document = vscode.window.activeTextEditor?.document;
  return document && document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
}

/** Runs a verb over the current change, against the branch this one came from. */
function changeCommand({ verb, busy, extra = [] }) {
  return async () => {
    const cwd = workspaceDir();
    if (!cwd) {
      vscode.window.showWarningMessage('Tewip: open the project folder first - this reads the change in the project you are working in.');
      return;
    }
    const base = await baseBranch(cwd);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: busy }, async () => {
      try {
        await show(await runTewip([verb, '--diff', `${base}...HEAD`, ...extra], cwd));
      } catch (error) {
        vscode.window.showErrorMessage(`Tewip: ${error.message}. Is it installed? \`npm i -g tewip-ai\`, or see the "tewip.path" setting.`);
      }
    });
  };
}

/**
 * Runs a verb over the file in the editor, which is what "check this" means while reading code.
 *
 * `wholeProject` is for the verbs that only make sense across everything: passing whichever file
 * happens to be open would narrow an accessibility check to a .ts file with no markup in it and
 * report, truthfully but uselessly, that nothing was found.
 */
function fileCommand({ verb, busy, needsFile, extra = [], wholeProject = false }) {
  return async () => {
    const cwd = workspaceDir();
    const file = wholeProject ? null : openFile();
    if (!cwd) {
      vscode.window.showWarningMessage('Tewip: open the project folder first.');
      return;
    }
    if (needsFile && !file) {
      vscode.window.showWarningMessage(`Tewip: open the file you want to ${verb} first.`);
      return;
    }
    const relative = file ? require('node:path').relative(cwd, file).split(require('node:path').sep).join('/') : '';
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: busy }, async () => {
      try {
        await show(await runTewip([verb, ...(relative ? [relative] : []), ...extra], cwd));
      } catch (error) {
        vscode.window.showErrorMessage(`Tewip: ${error.message}. Is it installed? \`npm i -g tewip-ai\`, or see the "tewip.path" setting.`);
      }
    });
  };
}

module.exports = { show, projectCommand, askThenRun, openFile, changeCommand, fileCommand, gitInfo, baseBranch };
