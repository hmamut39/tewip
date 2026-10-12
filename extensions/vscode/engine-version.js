// Whether the engine behind this shell is current enough to be trusted.
const vscode = require('vscode');
const { runTewip, workspaceDir } = require('./run.js');



/**
 * The engine this extension talks to, and whether it is old enough to be giving stale answers.
 *
 * This extension is a thin shell: it runs whatever `tewip` is on the PATH, which is why eleven
 * phases of engine work reach its users through `npm i -g tewip-ai` and not through a new build of
 * this. The cost of that design, found on 2026-10-12 on the author's own machine, is that the shell
 * looks identical whether the engine behind it is current or fifty versions old - it was running
 * 0.4.0 against an extension built for 0.54.0, and nothing anywhere said so. Silently answering out
 * of date is the one failure this project cannot afford, so the version is read and said out loud.
 *
 * Once per session, never on a timer, and never blocking a command: a nag is its own kind of harm.
 */
const NEEDS_ENGINE = 54; // the minor version this build was written against

let versionChecked = false;

async function checkEngineVersion() {
  if (versionChecked) return;
  versionChecked = true;
  let reported = '';
  try {
    reported = (await runTewip(['--version'], workspaceDir() ?? process.cwd())).trim();
  } catch {
    return; // not installed, or not on the PATH: the commands themselves say so, with the install line
  }
  const minor = Number(/^\d+\.(\d+)/.exec(reported)?.[1] ?? NaN);
  if (!Number.isFinite(minor) || minor >= NEEDS_ENGINE) return;
  const update = 'Update it';
  const answer = await vscode.window.showWarningMessage(
    `Tewip's command line is ${reported}, and this extension expects 0.${NEEDS_ENGINE} or newer. ` +
      'The extension runs whatever `tewip` is installed, so its answers are coming from the older one.',
    update,
    'Not now',
  );
  if (answer !== update) return;
  const terminal = vscode.window.createTerminal('Update Tewip');
  terminal.show();
  terminal.sendText('npm install -g tewip-ai@latest');
}

module.exports = { checkEngineVersion };
