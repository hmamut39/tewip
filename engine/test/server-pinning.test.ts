// OWASP ASI04, Agentic Supply Chain: where an agent's tool servers come from.
//
// OWASP cites one case for this risk by name. A package impersonating `postmark-mcp` sat on npm
// through a run of clean versions and then, in 1.0.16, began adding a hidden BCC of every email it
// sent to an address its author controlled. No configuration changed; `npx -y postmark-mcp` fetches
// whatever is newest at every start.
//
// `eval/supply-recall.ts` measures this against the invocations real MCP servers document, and
// `confidence-is-current.test.ts` re-derives that figure. These are the behaviours underneath it,
// and the last one holds Tewip's own shipped plugins to the rule. Phase 225.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pinnedTo, sourceOf } from '../agent/server-pinning.ts';

const HERE = join(import.meta.dirname, '..', '..');

describe('where a tool server’s code comes from', () => {
  it('reads an unpinned fetch as a choice made again on every start', () => {
    const got = sourceOf('files', 'npx', '-y @modelcontextprotocol/server-filesystem /data', '');
    assert.equal(got.how, 'fetched at every start');
    assert.equal(got.pin, null);
    assert.match(got.why, /postmark-mcp/, 'the case OWASP cites is quoted, so the reader can check it');
  });

  it('knows a scope from a version, because both are written with an @', () => {
    // `@scope/pkg` has a leading @ that is not a version separator. Getting this wrong either
    // reports every pinned scoped package or accepts every unpinned one.
    assert.equal(sourceOf('a', 'npx', '-y @scope/pkg', '').how, 'fetched at every start');
    const pinned = sourceOf('a', 'npx', '-y @scope/pkg@0.3.14', '');
    assert.equal(pinned.how, 'pinned');
    assert.equal(pinned.pin, '0.3.14');
  });

  it('does not accept a moving tag as a pin', () => {
    for (const tag of ['latest', 'next', 'beta', 'main', 'nightly']) {
      const got = sourceOf('a', 'npx', `-y some-mcp@${tag}`, '');
      assert.equal(got.how, 'fetched at every start', `@${tag} is the default with a version's clothes on`);
    }
  });

  it('accepts a container digest, and refuses a container with no tag', () => {
    assert.equal(sourceOf('a', 'docker', 'run -i --rm mcp/server', '').how, 'fetched at every start');
    const digest = sourceOf('a', 'docker', 'run -i --rm mcp/server@sha256:3f8c1d9a0b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a', '');
    assert.equal(digest.how, 'pinned');
    assert.match(digest.pin ?? '', /^sha256:/);
  });

  it('reads Python pins the Python way', () => {
    assert.equal(sourceOf('a', 'uvx', 'mcp-server-git', '').how, 'fetched at every start');
    assert.equal(sourceOf('a', 'uvx', 'mcp-server-git==0.6.2', '').pin, '0.6.2');
  });

  it('says nothing about a server built in this project', () => {
    for (const [command, args] of [
      ['node', './dist/mcp/server.js'],
      ['python3', '-m myproject.mcp'],
    ]) {
      assert.equal(sourceOf('a', command, args, '').how, 'from this project', `${command} ${args}`);
    }
  });

  it('treats a remote server as a different question, not an unpinned one', () => {
    const got = sourceOf('a', '', '', 'https://mcp.example.com/sse');
    assert.equal(got.how, 'somebody else’s service');
    assert.match(got.why, /Pinning is not the control for this one/);
    assert.doesNotMatch(got.what, /:\/\/[^/]*@/, 'and any credential in the URL is not printed back');
  });

  it('names the moving tag it found, rather than only saying no version', () => {
    // The verdict does not need this - a pin has to start with a digit, so `latest` would fail that
    // test anyway - but the sentence does. A reader looking at `@latest` has to be told that it is
    // the default with a version's clothes on, or they will read it as pinned and move on.
    const got = sourceOf('a', 'npx', '-y some-mcp@latest', '');
    assert.match(got.why, /`latest` is the default wearing a version/);
    assert.match(sourceOf('a', 'npx', '-y some-mcp@nightly', '').why, /`nightly` is the default wearing a version/);
    // And where there is no tag at all, it says that instead.
    assert.match(sourceOf('a', 'npx', '-y some-mcp', '').why, /with no version pinned/);
  });

  it('leaves the hook no unpinned fetch either, except the advice to a person', () => {
    // The hook falls back to `npx -y tewip-ai@<version>` when nothing is installed, and that line
    // was `@latest` until this was written. It is code rather than configuration, which is why the
    // ASI04 check could not see it and why it needs a test of its own.
    const ours = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')) as { version: string };
    for (const hook of ['plugin/hooks/vouch-edit.mjs', 'plugin-standalone/hooks/vouch-edit.mjs']) {
      const text = readFileSync(join(HERE, hook), 'utf8');
      const fetches = [...text.matchAll(/'tewip-ai@([^']+)', \.\.\.args/g)].map((m) => m[1]);
      assert.deepEqual(fetches, [ours.version], `${hook} fetches tewip-ai at ${fetches.join(', ')} and this release is ${ours.version}`);
      // The one `@latest` that stays: a sentence telling somebody to install the newest by hand.
      const advice = [...text.matchAll(/npm i -g tewip-ai@(\S+?)`/g)].map((m) => m[1]);
      assert.deepEqual(advice, ['latest'], 'the advice to a person should say latest, because that is what they want');
    }
  });

  it('pins an invocation to a version, which is what keeps this repository honest', () => {
    // A pure function rather than a transform inside the release script, because the only way to
    // test that one is to cut a release.
    const bare = pinnedTo(['-y', 'tewip-ai', 'mcp'], 'tewip-ai', '1.2.3');
    assert.deepEqual(bare.args, ['-y', 'tewip-ai@1.2.3', 'mcp']);
    assert.equal(bare.was, 'tewip-ai');

    const moving = pinnedTo(['-y', 'tewip-ai@latest', 'mcp'], 'tewip-ai', '1.2.3');
    assert.deepEqual(moving.args, ['-y', 'tewip-ai@1.2.3', 'mcp']);
    assert.equal(moving.was, 'tewip-ai@latest');

    // A package that merely starts with the same letters is not the one being pinned.
    const other = pinnedTo(['-y', 'tewip-ai-extras@2.0.0'], 'tewip-ai', '1.2.3');
    assert.deepEqual(other.args, ['-y', 'tewip-ai-extras@2.0.0'], 'left alone');
    assert.equal(other.was, null, 'and the caller is told nothing was pinned');
  });

  // The one that matters most, because it is about this repository rather than about a fixture.
  it('holds Tewip’s own shipped plugins to the same rule', () => {
    // Both plugins said `npx -y tewip-ai@latest mcp` until this check was written and run on them.
    // A plugin pinned at a version that runs whatever was published afterwards is not pinned.
    //
    // **Four files, not two.** This test checked the two `.mcp.json` files, and the README and
    // confidence.ts both said the plugin was pinned on the strength of it - while each
    // `plugin.json` declared the very same server in its own `mcpServers` block, still on
    // `@latest`, for seven weeks. The list is derived from the files that actually declare a
    // server rather than typed out, so a fifth place cannot be added without this noticing.
    const ours = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')) as { version: string };
    const declaring = ['plugin/.mcp.json', 'plugin-standalone/.mcp.json', 'plugin/.claude-plugin/plugin.json', 'plugin-standalone/.claude-plugin/plugin.json'].filter((f) =>
      readFileSync(join(HERE, f), 'utf8').includes('mcpServers'),
    );
    assert.equal(declaring.length, 4, 'a file that used to declare the MCP server no longer does, or a new one was added');
    for (const config of declaring) {
      const mcp = JSON.parse(readFileSync(join(HERE, config), 'utf8')) as { mcpServers: Record<string, { command?: string; args?: string[] }> };
      for (const [name, spec] of Object.entries(mcp.mcpServers)) {
        const got = sourceOf(name, spec.command ?? '', (spec.args ?? []).join(' '), '');
        assert.equal(got.how, 'pinned', `${config} ships ${name} unpinned: ${got.what}`);
        assert.equal(got.pin, ours.version, `${config} pins ${got.pin}, and this release is ${ours.version} - scripts/sync-version.ts keeps these together`);
      }
    }
  });
});
