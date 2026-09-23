// Tewip for VS Code and the editors built on it (Cursor, Windsurf, VSCodium).
// - Registers Tewip as an MCP server, so the editor's AI assistant can ask it "why did CI fail on
//   my PR?" with nothing to configure.
// - Adds commands for the things a person wants without leaving the editor: explain a report, the
//   latest CI for this branch, the risk review of the current change, the flaky-test dossier, the
//   security check, and what the team's corrections add up to. Every one runs the same `tewip`
//   command line people use in a terminal, in the open folder, and shows its Markdown.
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

const reviewChange = projectCommand({
  verb: 'review',
  args: ['--diff', 'main...HEAD'],
  busy: 'Tewip is reading what this change touches…',
  needs: 'It reads a git checkout with a `main` branch to compare against.',
});
const flakyDossier = projectCommand({ verb: 'flaky', args: ['--days', '30'], busy: 'Tewip is weighing the flaky tests…' });
const securityCheck = projectCommand({ verb: 'secure', busy: 'Tewip is checking secrets and dependencies…' });
const whatWeLearned = projectCommand({ verb: 'learn', busy: 'Tewip is reading your corrections…' });

async function explainReport() {
  const picked = await vscode.window.showOpenDialog({
    title: 'Tewip: pick a test report (JUnit XML, .trx) or a report folder',
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: workspaceDir() ? vscode.Uri.file(workspaceDir()) : undefined,
  });
  if (!picked?.[0]) return;
  // History goes in a .tewip folder where this runs: the open project, or, with no folder open,
  // next to the report - never the editor's own folder.
  const report = picked[0].fsPath;
  const cwd = workspaceDir() ?? require('node:path').dirname(report);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Tewip is reading the report…' }, async () => {
    try {
      await show(await runTewip(['explain', report], cwd));
    } catch (error) {
      vscode.window.showErrorMessage(`Tewip: ${error.message}. Is it installed? See the "tewip.path" setting.`);
    }
  });
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

async function ciReport() {
  const cwd = workspaceDir();
  const { repo, branch } = cwd ? await gitInfo(cwd) : {};
  if (!repo) {
    vscode.window.showWarningMessage('Tewip: open a folder that is a GitHub repository checkout to see its CI report.');
    return;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Tewip is fetching CI for ${repo}${branch ? ` (${branch})` : ''}…` }, async () => {
    try {
      await show(await runTewip(['ci', repo, ...(branch ? ['--branch', branch] : [])], cwd));
    } catch (error) {
      vscode.window.showErrorMessage(`Tewip: ${error.message}. It needs the GitHub CLI (gh) signed in.`);
    }
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('tewip.explainReport', explainReport),
    vscode.commands.registerCommand('tewip.ciReport', ciReport),
    vscode.commands.registerCommand('tewip.review', reviewChange),
    vscode.commands.registerCommand('tewip.flaky', flakyDossier),
    vscode.commands.registerCommand('tewip.secure', securityCheck),
    vscode.commands.registerCommand('tewip.learn', whatWeLearned),
  );
  // Editors that support it pick Tewip up as an MCP server with no configuration; others can
  // still add "tewip mcp" to their MCP settings by hand.
  if (vscode.lm?.registerMcpServerDefinitionProvider && vscode.McpStdioServerDefinition) {
    const changed = new vscode.EventEmitter();
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('tewip', {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => {
          const { command, args } = tewipCommand();
          return [new vscode.McpStdioServerDefinition('Tewip', command, [...args, 'mcp'])];
        },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tewip.path') && changed.fire()),
      changed,
    );
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
