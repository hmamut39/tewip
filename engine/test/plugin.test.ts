// Phase 193: the plugin surface, which nothing was watching.
//
// Two manifests declared version **0.49.0** while the package was on 0.84.0 - thirty-five releases,
// shown to anybody browsing the marketplace. `scripts/sync-version.ts` existed because server.json
// had exactly this problem and had been written to fix it; the plugin manifests were never added.
// The same defect, in the same shape, one directory over, and no test looked.
//
// The hooks are new in the same phase. A hook that is malformed does nothing at all and says
// nothing about it, which is the failure this project keeps finding in other people's reports: the
// silence of a thing that is not there reads exactly like the silence of a thing with nothing to
// say.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const MANIFESTS = ['plugin/.claude-plugin/plugin.json', 'plugin-standalone/.claude-plugin/plugin.json'];

describe('the Claude Code plugin', () => {
  const version = read('package.json').version as string;

  it('declares the version this project is actually on', () => {
    for (const m of MANIFESTS) {
      assert.equal(
        read(m).version,
        version,
        `${m} says ${read(m).version} and the package is ${version}. ` +
          'A marketplace listing showing an old version is the stale channel that looks exactly like a current one.',
      );
    }
  });

  it('is synced by the script that runs on every release, not by somebody remembering', () => {
    // The guard above catches the drift. This one catches the reason it drifted: a version bumped
    // by hand is a version that will be forgotten, and `npm version` runs this file.
    const sync = readFileSync(join(ROOT, 'scripts', 'sync-version.ts'), 'utf8');
    for (const m of MANIFESTS) assert.ok(sync.includes(m), `${m} is not synced by scripts/sync-version.ts`);
  });

  it('stages every file the version script writes, not a list beside it', () => {
    // The 0.85.0 release failed on exactly this. `scripts/sync-version.ts` wrote three files and
    // package.json staged one of them by name, so the version commit carried a plugin manifest a
    // release behind - and the guard above caught it in CI, after the tag was already pushed.
    //
    // The staging is now derived from what the script recorded writing. This test holds that: a
    // hand-kept list of files to stage, beside a hand-kept list of files to write, is how the
    // first one went stale.
    const sync = readFileSync(join(ROOT, 'scripts', 'sync-version.ts'), 'utf8');
    assert.match(sync, /git', \['add', \.\.\.wrote\]/, 'the script must stage the files it recorded writing');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.ok(!pkg.scripts.version.includes('git add'), 'package.json must not name files to stage; the script knows which it wrote');
    for (const m of MANIFESTS) assert.ok(sync.includes(m), `${m} is written by the script, so it is staged by it`);
  });

  it('points the marketplace at a directory that exists', () => {
    const market = read('.claude-plugin/marketplace.json') as { plugins: Array<{ source: string }> };
    for (const p of market.plugins) {
      const where = p.source.replace(/^\.\//, '');
      assert.ok(existsSync(join(ROOT, where)), `the marketplace lists ${p.source} and there is no such directory`);
      assert.ok(existsSync(join(ROOT, where, '.claude-plugin', 'plugin.json')), `${p.source} has no plugin.json, so nothing would install`);
    }
  });

  it('ships hooks that are shaped the way Claude Code reads them', () => {
    for (const dir of ['plugin', 'plugin-standalone']) {
      const hooks = read(`${dir}/hooks/hooks.json`) as { description?: string; hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> };
      assert.ok(hooks.description, `${dir}/hooks/hooks.json has no description`);
      const post = hooks.hooks.PostToolUse;
      assert.ok(Array.isArray(post) && post.length > 0, `${dir} declares no PostToolUse hook`);
      for (const entry of post) {
        assert.ok(entry.matcher, 'a hook entry with no matcher runs on everything, which is not what this one wants');
        for (const h of entry.hooks) {
          assert.equal(h.type, 'command');
          assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}/, 'a hook must find its own script by plugin root, not by a path on somebody else machine');
          // Every path exits 0. A hook that fails a tool call is worse than no hook.
          assert.match(h.command, /\|\| true/, 'the hook must not be able to fail the tool call it follows');
        }
      }
    }
  });

  it('keeps the hook script beside the manifest that names it', () => {
    for (const dir of ['plugin', 'plugin-standalone']) {
      const hooks = readFileSync(join(ROOT, dir, 'hooks', 'hooks.json'), 'utf8');
      const named = [...hooks.matchAll(/hooks\/([\w.-]+\.mjs)/g)].map((m) => m[1]);
      assert.ok(named.length > 0, `${dir}/hooks/hooks.json names no script`);
      for (const script of named) {
        assert.ok(existsSync(join(ROOT, dir, 'hooks', script)), `${dir}/hooks/hooks.json runs ${script} and it is not there`);
      }
    }
  });

  it('says so when the installed Tewip is too old to read the path it is given', () => {
    // Phase 195. This hook is only ever handed an absolute path, and every published version before
    // Phase 193 answered "no test file was read" for one. Left alone it would run on every test
    // Claude wrote, find nothing, say nothing, and look exactly like a hook that had looked and
    // been satisfied - which is the silence this project spends its phases refusing to let stand.
    const script = readFileSync(join(ROOT, 'plugin', 'hooks', 'vouch-edit.mjs'), 'utf8');
    assert.match(script, /No test file was read/, 'the hook must notice the symptom of a binary that cannot read its path');
    assert.match(script, /npm i -g tewip-ai@latest/, 'and say what to do about it');
  });

  it('keeps the two plugin copies identical where it matters', () => {
    // `plugin/` is what the marketplace installs and `plugin-standalone/` is what somebody copies.
    // A fix applied to one and not the other is a fix half the users do not get.
    for (const f of ['hooks/hooks.json', 'hooks/vouch-edit.mjs']) {
      assert.equal(
        readFileSync(join(ROOT, 'plugin', f), 'utf8'),
        readFileSync(join(ROOT, 'plugin-standalone', f), 'utf8'),
        `${f} differs between plugin/ and plugin-standalone/`,
      );
    }
  });

  it('runs the one check that is worth a person being interrupted for', () => {
    // `vouch` and not something broader, on purpose. It needs no model, it takes about a second,
    // and it answers the question agentic coding actually gets wrong: a model asked to make a
    // suite pass can do it by writing a test that cannot fail.
    const script = readFileSync(join(ROOT, 'plugin', 'hooks', 'vouch-edit.mjs'), 'utf8');
    assert.match(script, /'vouch'/, 'the hook should run vouch');
    assert.match(script, /cannot fail at all/, 'and should report only the count that matters');
    assert.match(script, /process\.exit\(0\)/, 'and must always exit 0');
  });
});
