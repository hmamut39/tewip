// Tewip for VS Code and the editors built on it (Cursor, Windsurf, VSCodium).
// - Registers Tewip as an MCP server, so the editor's AI assistant can ask it "why did CI fail on
//   my PR?" with nothing to configure.
// - Adds two commands: explain a test report on disk, and show the latest CI report for the
//   current branch. Both run the same `tewip` command line people use in a terminal.
const vscode = require('vscode');
const { execFile } = require('node:child_process');

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

/** Runs `tewip <args>` in the workspace and resolves with its output. */
function runTewip(args, cwd) {
  const { command, args: lead } = tewipCommand();
  return new Promise((resolve, reject) => {
    execFile(command, [...lead, ...args], { cwd, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32', env: process.env }, (error, stdout, stderr) => {
      if (error && !stdout) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** Shows Markdown output in a new editor with a rendered preview beside it. */
async function show(markdown) {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(doc, { preview: true });
  await vscode.commands.executeCommand('markdown.showPreviewToSide');
}

async function explainReport() {
  const picked = await vscode.window.showOpenDialog({
    title: 'Tewip: pick a test report (JUnit XML, .trx) or a report folder',
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: workspaceDir() ? vscode.Uri.file(workspaceDir()) : undefined,
  });
  if (!picked?.[0]) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Tewip is reading the report…' }, async () => {
    try {
      await show(await runTewip(['explain', picked[0].fsPath], workspaceDir()));
    } catch (error) {
      vscode.window.showErrorMessage(`Tewip: ${error.message}. Is it installed? See the "tewip.path" setting.`);
    }
  });
}

/** owner/repo and branch of the workspace's git checkout, read from git itself. */
function gitInfo(cwd) {
  const git = (args) => new Promise((resolve) => execFile('git', args, { cwd }, (e, out) => resolve(e ? '' : out.trim())));
  return Promise.all([git(['remote', 'get-url', 'origin']), git(['branch', '--show-current'])]).then(([remote, branch]) => ({
    repo: remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1],
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
