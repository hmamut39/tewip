// Finding and running the Tewip command line, and the Windows quoting it needs.
//
// Split out of extension.js in Phase 45, when the engine-version check pushed that file past the
// 300-line rule this project keeps. Nothing here knows what a command means; it starts a process.
const vscode = require('vscode');
const { exec, execFile } = require('node:child_process');

/** The program and leading arguments that run Tewip, from the `tewip.path` setting. */
function tewipCommand() {
  const setting = (vscode.workspace.getConfiguration('tewip').get('path') || 'tewip').trim();
  // A path to the script itself runs under Node; anything else is taken as the command to run.
  if (/\.(ts|js|mjs)$/i.test(setting)) return { command: 'node', args: [setting] };
  return { command: setting, args: [] };
}

function workspaceDir() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * On Windows the `tewip` command is a .cmd file, which only runs through cmd.exe, and cmd.exe
 * splits and interprets an unquoted command line: a path with a space would break in two, and an
 * "&" in a folder or branch name would start a second command. Every argument is quoted, and a
 * "%" (which cmd.exe expands even inside quotes) is refused rather than guessed at.
 */
function forCmd(arg) {
  if (/[%\r\n]/.test(arg)) throw new Error(`cannot pass "${arg}" safely to the Windows command line (it contains % or a line break)`);
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Runs `tewip <args>` in `cwd` and resolves with its output. */
function runTewip(args, cwd) {
  const { command, args: lead } = tewipCommand();
  const windows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    let all;
    try {
      all = windows ? [command, ...lead, ...args].map(forCmd) : [...lead, ...args];
    } catch (error) {
      reject(error);
      return;
    }
    const done = (error, stdout, stderr) => {
      if (error && !stdout) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    };
    const options = { cwd, maxBuffer: 32 * 1024 * 1024, env: process.env };
    // Windows: one command line, every part already quoted by forCmd, run by cmd.exe.
    if (windows) exec(all.join(' '), options, done);
    else execFile(command, all, options, done);
  });
}

module.exports = { tewipCommand, workspaceDir, runTewip };
