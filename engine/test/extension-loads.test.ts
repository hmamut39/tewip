// Phase 119: does the extension actually load?
//
// Everything else that checks the extension reads it as text - `source.includes('tewip.recall')`
// and so on. That catches a command with no handler, and catches nothing about whether the thing
// runs. 0.14.0 split extension.js into three modules to stay under the 300-line rule, and a
// mistyped `require` or a missing export in that split would have passed every existing test and
// then failed at activation, in the editor, on somebody's machine, with a stack trace they cannot
// do anything about.
//
// So this loads it for real against a stub of the editor API, and activates it. Nothing here
// asserts that a command does the right thing - that needs a running editor - only that every one
// of them is reachable, which is the part a split can break.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const PROJECT_ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIR = join(PROJECT_ROOT, 'extensions', 'vscode');

/** Just enough of the editor API for the module graph to load and `activate` to run. */
function editorStub(registered: string[]) {
  const noop = () => undefined;
  return {
    window: {
      showInformationMessage: noop,
      showWarningMessage: noop,
      showErrorMessage: noop,
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showTextDocument: async () => undefined,
      withProgress: async (_: unknown, run: () => Promise<unknown>) => run(),
      activeTextEditor: undefined,
    },
    workspace: { workspaceFolders: undefined, openTextDocument: async () => ({}), getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: noop }) },
    commands: {
      registerCommand: (id: string) => {
        registered.push(id);
        return { dispose: noop };
      },
      executeCommand: async () => undefined,
    },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    EventEmitter: class {
      event = () => ({ dispose: noop });
      fire = noop;
      dispose = noop;
    },
    // Absent on purpose: the MCP registration is behind a capability check, and the branch where
    // the editor does not support it is the one most editors take.
    lm: undefined,
  };
}

/** Loads extension.js with `require('vscode')` answered by the stub. */
function load(registered: string[]): { activate: (ctx: unknown) => void } {
  const require_ = createRequire(join(DIR, 'extension.js'));
  const Module = require_('node:module') as { _load: (...args: unknown[]) => unknown };
  const original = Module._load;
  const stub = editorStub(registered);
  Module._load = (request: unknown, ...rest: unknown[]) => (request === 'vscode' ? stub : original.call(Module, request, ...rest));
  try {
    for (const file of ['extension.js', 'factories.js', 'correct.js', 'run.js', 'engine-version.js']) {
      delete (require_.cache ?? {})[require_.resolve(join(DIR, file))];
    }
    return require_(join(DIR, 'extension.js')) as { activate: (ctx: unknown) => void };
  } finally {
    Module._load = original;
  }
}

describe('the extension loads and reaches every command', () => {
  it('requires cleanly across all three modules', () => {
    const registered: string[] = [];
    const mod = load(registered);
    assert.equal(typeof mod.activate, 'function', 'activate must be exported or the editor cannot start it');
  });

  it('registers every command its manifest promises', async () => {
    const registered: string[] = [];
    const mod = load(registered);
    mod.activate({ subscriptions: [] });

    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string }> } };
    const promised = manifest.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual(
      [...registered].sort(),
      promised,
      'a command in the palette that activate never registers fails with "command not found" when it is clicked',
    );
  });

  it('registers the correction command, which is the one the loop was missing', () => {
    // Named on its own because `learn` shipped without it for eighteen versions: the extension
    // reported on corrections and offered no way to make one.
    const registered: string[] = [];
    load(registered).activate({ subscriptions: [] });
    assert.ok(registered.includes('tewip.correct'));
  });
});
