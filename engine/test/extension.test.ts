// Phase 61: the editor extension, which until now had no test of any kind.
//
// It is a thin shell - it runs whatever `tewip` is on the PATH - so every phase of engine work
// reaches its users without a new build of it. That design is right, and it has one cost: the shell
// looks identical whether the engine behind it is current or fifty versions old. The guard written
// for that was a hand-typed constant, `NEEDS_ENGINE = 54`, and by the time the engine reached 0.69
// the guard against a stale engine had itself gone fifteen versions stale. Nobody sitting on 0.54
// was told anything, through six phases of work.
//
// So what is pinned here is the part that can rot silently: that the comparison is right, that the
// fallback floor has not drifted far from the engine, that every command the extension offers in a
// menu has a handler behind it, and that the published .vsix matches the version in package.json.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../reporters/store.ts';
import { FLOOR, isBehind, parts } from '../../extensions/vscode/version-compare.js';

const DIR = join(PROJECT_ROOT, 'extensions', 'vscode');
const manifest = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as {
  version: string;
  contributes: { commands: Array<{ command: string; title: string }>; configuration: { properties: Record<string, { default?: unknown }> } };
};
const source = readFileSync(join(DIR, 'extension.js'), 'utf8');
const engineVersion = (JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

describe('is the engine behind the extension', () => {
  it('reads a version the way a version is written', () => {
    assert.deepEqual(parts('0.69.1'), [0, 69]);
    assert.deepEqual(parts(' 1.0.0 '), [1, 0]);
    assert.equal(parts('not a version'), null);
    assert.equal(parts(''), null);
  });

  it('calls an older minor behind, which is the case that went unreported for six phases', () => {
    assert.equal(isBehind('0.54.0', '0.69.1'), true);
    assert.equal(isBehind('0.4.0', '0.69.1'), true);
    assert.equal(isBehind('0.69.0', '0.70.0'), true);
  });

  it('does not nag about a patch release, which changes nothing the extension can ask for', () => {
    assert.equal(isBehind('0.69.0', '0.69.1'), false);
    assert.equal(isBehind('0.69.5', '0.69.1'), false);
  });

  it('never calls the current one behind, or guesses from something unreadable', () => {
    assert.equal(isBehind('0.69.1', '0.69.1'), false);
    assert.equal(isBehind('0.70.0', '0.69.1'), false, 'a newer engine is not stale');
    assert.equal(isBehind('', '0.69.1'), false, 'silence beats a warning drawn from nothing');
    assert.equal(isBehind('0.69.1', 'unknown'), false);
  });

  // The whole point of this phase. The floor is now only a fallback - the live check asks npm - but a
  // fallback that is fifteen versions out is the bug this file exists to stop coming back.
  it('keeps the fallback floor within sight of the engine it ships beside', () => {
    const engineMinor = Number(parts(engineVersion)?.[1] ?? NaN);
    assert.ok(Number.isFinite(engineMinor), `could not read the engine version: ${engineVersion}`);
    assert.ok(
      engineMinor - FLOOR <= 10,
      `extensions/vscode floor is 0.${FLOOR} and the engine is ${engineVersion}: ${engineMinor - FLOOR} minor versions apart. ` +
        'Raise FLOOR in extensions/vscode/version-compare.js and bump the extension, or someone with an old command line is told nothing.',
    );
    assert.ok(FLOOR <= engineMinor, `floor 0.${FLOOR} is ahead of the engine ${engineVersion}, which would warn everyone forever`);
  });

  it('lets a person turn the npm lookup off, because it reaches the network', () => {
    const setting = manifest.contributes.configuration.properties['tewip.checkForUpdates'];
    assert.ok(setting, 'a check that reaches the network has to be refusable');
    assert.equal(setting.default, true, 'and on by default, because an old engine gives old answers silently');
  });

  it('asks only after a command is run, never on startup', () => {
    // `onStartupFinished` activation plus a check in activate() meant asking the registry on behalf
    // of somebody who had not asked Tewip for anything.
    assert.doesNotMatch(source, /function activate\([^)]*\)\s*\{\s*(\/\/[^\n]*\n\s*)*void checkEngineVersion/, 'the check must not run from activate');
    assert.match(source, /registerCommand\(id, \(\.\.\.args\) => \{\s*\n\s*void checkEngineVersion\(context\);/, 'it runs on the first command instead');
  });
});

describe('what the extension offers and what it can actually do', () => {
  it('has a handler for every command it puts in a menu', () => {
    const declared = manifest.contributes.commands.map((c) => c.command);
    assert.ok(declared.length >= 18, `only ${declared.length} commands declared`);
    const missing = declared.filter((id) => !source.includes(`'${id}'`));
    assert.deepEqual(missing, [], 'a command in the palette with nothing behind it is worse than no command');
  });

  it('registers nothing it has not declared, which would be unreachable', () => {
    const declared = new Set(manifest.contributes.commands.map((c) => c.command));
    const registered = [...source.matchAll(/command\('(tewip\.[A-Za-z]+)'/g)].map((m) => m[1]);
    assert.ok(registered.length > 0, 'the registration block was not found, so this test proves nothing');
    assert.deepEqual(
      registered.filter((id) => !declared.has(id)),
      [],
      'a registered command that is not contributed cannot be reached from the palette',
    );
  });

  it('has a built .vsix for the version in its manifest, where builds are kept at all', () => {
    // The VS Code Marketplace upload is manual, and the file is what gets uploaded. A release whose
    // .vsix was never built is a release that only reached Open VSX.
    //
    // `.vsix` is gitignored, so a fresh clone and every CI runner has none - and a test that
    // demands one there would fail for a reason that has nothing to do with the code. It checks the
    // pairing only where builds are being kept: if earlier versions are sitting beside
    // package.json, this version's should be too.
    const built = readdirSync(DIR).filter((f) => f.endsWith('.vsix'));
    if (built.length === 0) return; // a clean checkout: nothing to be inconsistent with
    assert.ok(built.includes(`tewip-${manifest.version}.vsix`), `${built.length} .vsix file(s) here but none for ${manifest.version}: ${built.join(', ')}. Run vsce package before publishing.`);
  });

  it('keeps the publisher the Open VSX namespace expects', () => {
    const { publisher } = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as { publisher: string };
    assert.equal(publisher, 'hmamut39', 'a mismatch here fails the publish with an obscure error');
  });

  it('has the files it says it has', () => {
    for (const file of ['extension.js', 'run.js', 'engine-version.js', 'version-compare.js', 'README.md', 'icon.png']) {
      assert.ok(existsSync(join(DIR, file)), `extensions/vscode/${file} is missing`);
    }
  });
});
