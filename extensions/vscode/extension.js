// Tewip for VS Code and the editors built on it (Cursor, Windsurf, VSCodium).
// - Registers Tewip as an MCP server, so the editor's AI assistant can ask it "why did CI fail on
//   my PR?" with nothing to configure.
// - Adds commands for the things a person wants without leaving the editor: explain a report, the
//   latest CI for this branch, the risk review of the current change, the flaky-test dossier, the
//   security check, and what the team's corrections add up to. Every one runs the same `tewip`
//   command line people use in a terminal, in the open folder, and shows its Markdown.
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const { runTewip, tewipCommand, workspaceDir } = require('./run.js');
const { checkEngineVersion } = require('./engine-version.js');


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
const traceRequirements = projectCommand({ verb: 'trace', busy: 'Tewip is following the thread from plan to run…' });
const evidenceBundle = projectCommand({ verb: 'attest', busy: 'Tewip is gathering what it checked…' });
const securityCheck = projectCommand({ verb: 'secure', busy: 'Tewip is checking secrets and dependencies…' });
const whatWeLearned = projectCommand({ verb: 'learn', busy: 'Tewip is reading your corrections…' });

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

const recallMemory = askThenRun({
  verb: 'recall',
  prompt: 'Tewip: has this happened here before?',
  placeHolder: 'Paste an error, or ask in plain words',
  busy: 'Tewip is searching what this project already decided…',
});
const pursueGoal = askThenRun({
  verb: 'pursue',
  prompt: 'Tewip: what should be done next about…?',
  placeHolder: 'e.g. keep the checkout flow green',
  busy: 'Tewip is deciding what to do next…',
});

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

const isThisDone = changeCommand({ verb: 'done', busy: 'Tewip is deciding whether this work is done…' });
const whichTests = changeCommand({ verb: 'pick', busy: 'Tewip is working out which tests could notice this change…' });
const readMigrations = changeCommand({ verb: 'schema', busy: 'Tewip is reading what the migration does to a live database…' });
const houseRules = fileCommand({ verb: 'standards', busy: "Tewip is reading this project's own standards…", needsFile: false });
const couldItFail = fileCommand({ verb: 'vouch', busy: 'Tewip is checking whether these tests could ever fail…', needsFile: true });
const whoCannotUseIt = fileCommand({ verb: 'access', busy: 'Tewip is checking who cannot use this interface…', needsFile: false, wholeProject: true });
// Needs the report file itself, so the open editor is the right thing to pass: a person runs this
// with their k6 summary or Lighthouse JSON in front of them.
const isItSlower = fileCommand({ verb: 'perf', busy: 'Tewip is checking whether this is slower than it was…', needsFile: true });
// Proving breaks the file and runs the tests that cover it, once per change, so it is slow by nature.
const wouldTestsCatch = fileCommand({ verb: 'prove', busy: 'Tewip is breaking this file to see whether the tests notice (this takes minutes)…', needsFile: true, extra: ['--limit', '4'] });

/**
 * Registers a command, and has the first use of any of them trigger the engine-version check.
 *
 * The check used to run from `activate`, which `onStartupFinished` means every time the editor
 * starts - so it asked the npm registry on behalf of someone who had not asked Tewip for anything.
 * A tool that reaches the network on startup is doing something the person did not request, and
 * this one has no reason to: nothing is stale until a command is run. So the first command a person
 * runs triggers it, unawaited, and it never delays that command.
 */
function registerWatched(context, id, handler) {
  return vscode.commands.registerCommand(id, (...args) => {
    void checkEngineVersion(context);
    return handler(...args);
  });
}

function activate(context) {
  const command = (id, handler) => registerWatched(context, id, handler);
  context.subscriptions.push(
    command('tewip.explainReport', explainReport),
    command('tewip.ciReport', ciReport),
    command('tewip.review', reviewChange),
    command('tewip.flaky', flakyDossier),
    command('tewip.secure', securityCheck),
    command('tewip.learn', whatWeLearned),
    command('tewip.trace', traceRequirements),
    command('tewip.attest', evidenceBundle),
    command('tewip.recall', recallMemory),
    command('tewip.pursue', pursueGoal),
    command('tewip.done', isThisDone),
    command('tewip.vouch', couldItFail),
    command('tewip.prove', wouldTestsCatch),
    command('tewip.pick', whichTests),
    command('tewip.schema', readMigrations),
    command('tewip.standards', houseRules),
    command('tewip.access', whoCannotUseIt),
    command('tewip.perf', isItSlower),
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
