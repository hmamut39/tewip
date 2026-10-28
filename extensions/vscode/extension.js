// Tewip for VS Code and the editors built on it (Cursor, Windsurf, VSCodium).
// - Registers Tewip as an MCP server, so the editor's AI assistant can ask it "why did CI fail on
//   my PR?" with nothing to configure.
// - Adds commands for the things a person wants without leaving the editor: explain a report, the
//   latest CI for this branch, the risk review of the current change, the flaky-test dossier, the
//   security check, and what the team's corrections add up to. Every one runs the same `tewip`
//   command line people use in a terminal, in the open folder, and shows its Markdown.
const vscode = require('vscode');
const { runTewip, tewipCommand, workspaceDir } = require('./run.js');
const { show, projectCommand, askThenRun, changeCommand, fileCommand, gitInfo } = require('./factories.js');
const { checkEngineVersion } = require('./engine-version.js');
const { correctSomething } = require('./correct.js');


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
const weeklyNote = projectCommand({
  verb: 'note',
  args: ['--days', '7'],
  busy: 'Tewip is writing the week from the runs it already diagnosed…',
  needs: 'It reads the history Tewip keeps. Run a report or two first, so there is a week to write about.',
});
const tellItItWasWrong = correctSomething();

const recallMemory = askThenRun({
  verb: 'recall',
  prompt: 'Tewip: has this happened here before?',
  placeHolder: 'Paste an error, or ask in plain words',
  busy: 'Tewip is searching what this project already decided…',
});
const writeSpec = askThenRun({
  verb: 'spec',
  prompt: 'Tewip: what is the feature?',
  placeHolder: 'e.g. customers can save a card for next time',
  busy: 'Tewip is writing the stories, and checking every claim against the code…',
});
const writeTestPlan = askThenRun({
  verb: 'plan',
  prompt: 'Tewip: what should the plan cover?',
  placeHolder: 'e.g. checkout with an expired card',
  busy: 'Tewip is writing a plan grounded in this project…',
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


const isThisDone = changeCommand({ verb: 'done', busy: 'Tewip is deciding whether this work is done…' });
const whichTests = changeCommand({ verb: 'pick', busy: 'Tewip is working out which tests could notice this change…' });
const readMigrations = changeCommand({ verb: 'schema', busy: 'Tewip is reading what the migration does to a live database…' });
const houseRules = fileCommand({ verb: 'standards', busy: "Tewip is reading this project's own standards…", needsFile: false });
const couldItFail = fileCommand({ verb: 'vouch', busy: 'Tewip is checking whether these tests could ever fail…', needsFile: true });
// The open file is the incident: a Sentry export, an OpenTelemetry span, or a stack trace somebody
// pasted into a ticket and saved. All three are what `incident` reads.
const reproduceIncident = fileCommand({
  verb: 'incident',
  busy: 'Tewip is writing a test for the incident, and keeping it only if it fails the way production did…',
  needsFile: true,
});
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
    command('tewip.correct', tellItItWasWrong),
    command('tewip.incident', reproduceIncident),
    command('tewip.note', weeklyNote),
    command('tewip.spec', writeSpec),
    command('tewip.plan', writeTestPlan),
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
