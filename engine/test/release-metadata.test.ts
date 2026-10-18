// The three files that have to agree before a release can be cut, checked on every push.
//
// Each of these agreements was already checked - inside .github/workflows/publish-mcp.yml, at the
// moment a `v*` tag is pushed. That is the most expensive place to find out. v0.70.14 was tagged
// with server.json still reading 0.70.13, and the only way to correct a tag-triggered publish is to
// cut another tag; the registry listing sat a version behind in the meantime.
//
// The guard itself was right, and its reasoning is worth keeping: "A listing that points at a
// version nobody can install is worse than no listing." It was only standing in the wrong place.
// Here it fails in a second, on the commit that breaks it, before anything has been published.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const pkg = read('package.json');
const server = read('server.json');

describe('the files a release is cut from agree with each other', () => {
  it('server.json carries the version in package.json', () => {
    assert.equal(server.version, pkg.version, 'server.json version and package.json version must match, or the MCP listing points at a version nobody can install');
  });

  it('the package entry inside server.json carries it too', () => {
    // Two separate fields, and the registry validates the inner one: a release where only the outer
    // was bumped would list correctly and resolve to the wrong tarball.
    assert.equal(server.packages[0].version, pkg.version);
  });

  it('names the npm package that actually exists', () => {
    assert.equal(server.packages[0].identifier, pkg.name);
  });

  it('mcpName and the server name match, which is what proves one owner', () => {
    // The registry checks that the published npm package carries `mcpName` equal to the listing's
    // name. If these drift, the listing cannot be claimed by this repository at all.
    assert.equal(pkg.mcpName, server.name);
  });

  it('the extension declares a version of its own', () => {
    // It is deliberately not tied to the engine's version - most releases do not touch it - but it
    // has to be a version, because Open VSX refuses a republish of one it already holds.
    const extension = read('extensions/vscode/package.json');
    assert.match(String(extension.version), /^\d+\.\d+\.\d+$/);
  });
});
