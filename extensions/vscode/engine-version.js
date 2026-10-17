// Whether the engine behind this shell is current enough to be trusted.
const vscode = require('vscode');
const https = require('node:https');
const { runTewip, workspaceDir } = require('./run.js');
const { FLOOR, parts, isBehind } = require('./version-compare.js');

/**
 * The engine this extension talks to, and whether it is behind the one that is available.
 *
 * This extension is a thin shell: it runs whatever `tewip` is on the PATH, which is why every phase
 * of engine work reaches its users through `npm i -g tewip-ai` and not through a new build of this.
 * The cost of that design, found on 2026-10-12 on the author's own machine, is that the shell looks
 * identical whether the engine behind it is current or fifty versions old - it was running 0.4.0
 * against an extension built for 0.54.0, and nothing anywhere said so.
 *
 * The first answer to that was a constant, `NEEDS_ENGINE = 54`, hand-typed at the minor version the
 * build was written against. By Phase 61 the engine was on 0.69 and the constant still said 54: the
 * guard against a stale engine had itself gone fifteen versions stale, and anyone sitting on 0.54
 * was missing six phases of work with nothing anywhere saying so. **A number a human has to
 * remember to update is not a guard, it is a second thing to forget.**
 *
 * So the comparison is against what is actually published, asked of the same registry the user
 * installed from, at most once a day, only after they have run a Tewip command themselves, and
 * never blocking one. The constant stays as the floor for when that lookup cannot be made - offline,
 * behind a proxy, or with the check turned off - because being unable to ask is not a reason to say
 * nothing at all.
 */
const ASK_NPM_EVERY_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3000;
/** Where the last lookup is remembered, so a reload is not a reason to ask again. */
const LAST_ASKED = 'tewip.engineCheckedAt';

let versionChecked = false;

/** The newest `tewip-ai` on npm, or '' when it cannot be asked. Never throws, never retries. */
function latestOnNpm() {
  return new Promise((resolve) => {
    const settle = (value) => resolve(typeof value === 'string' ? value : '');
    const request = https.get(
      'https://registry.npmjs.org/tewip-ai/latest',
      { timeout: LOOKUP_TIMEOUT_MS, headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          settle('');
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1_000_000) request.destroy(); // a registry that answers with a book is not answering
        });
        response.on('end', () => {
          try {
            settle(JSON.parse(body).version);
          } catch {
            settle('');
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => settle(''));
  });
}

async function checkEngineVersion(context) {
  if (versionChecked) return;
  versionChecked = true;

  let reported = '';
  try {
    reported = (await runTewip(['--version'], workspaceDir() ?? process.cwd())).trim();
  } catch {
    return; // not installed, or not on the PATH: the commands themselves say so, with the install line
  }
  if (!parts(reported)) return;

  const wanted = vscode.workspace.getConfiguration('tewip').get('checkForUpdates') !== false ? await askNpmAtMostDaily(context) : '';
  // Without an answer from npm, the floor is all there is - and a floor that says nothing when the
  // engine is merely a few versions old is the honest limit of a number written months ago.
  const behind = wanted ? isBehind(reported, wanted) : isBehind(reported, `0.${FLOOR}`);
  if (!behind) return;

  const update = 'Update it';
  const answer = await vscode.window.showWarningMessage(
    `Tewip's command line is ${reported}${wanted ? ` and ${wanted} is published` : `, and this extension was built against 0.${FLOOR}`}. ` +
      'The extension runs whatever `tewip` is installed, so its answers are coming from the older one.',
    update,
    'Not now',
  );
  if (answer !== update) return;
  const terminal = vscode.window.createTerminal('Update Tewip');
  terminal.show();
  terminal.sendText('npm install -g tewip-ai@latest');
}

/**
 * The registry, asked at most once a day.
 *
 * Remembered in the extension's own global state, so reloading the window is not a reason to ask
 * again. A failed lookup is not remembered: being offline for a minute should not mean being quiet
 * for a day.
 */
async function askNpmAtMostDaily(context) {
  const last = Number(context?.globalState?.get(LAST_ASKED) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < ASK_NPM_EVERY_MS) return '';
  const version = await latestOnNpm();
  if (version) await context?.globalState?.update(LAST_ASKED, Date.now());
  return version;
}

module.exports = { checkEngineVersion };
