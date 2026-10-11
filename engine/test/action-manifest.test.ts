// The GitHub Action's manifest, checked by something other than hope.
//
// Written after finding that `action.yml` had been unloadable since at least v0.34.0. Its
// description was an unquoted scalar containing ": ", which YAML reads as a nested mapping, so the
// runner failed with "Failed to load action.yml" the moment anyone used the action - while the
// README and every release note told people `uses: hmamut39/tewip@v0.34.0` worked.
//
// Nothing caught it because nothing had ever run the action: the publish workflows do not use it,
// and the manifest is data rather than code, so neither the typechecker nor 868 passing tests had
// any opinion about it. A workflow that runs Tewip against itself found it within minutes of
// existing, and this is the cheaper guard that keeps it found.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CHECKS } from '../../ci/check.ts';

const manifest = readFileSync('action.yml', 'utf8');
const lines = manifest.split(String.fromCharCode(10));

describe('action.yml is loadable', () => {
  it('has no unquoted scalar containing a colon and a space', () => {
    const broken: string[] = [];
    for (const [i, line] of lines.entries()) {
      // A key whose value starts bare - not quoted, not a block scalar, not a comment.
      const m = /^(\s*)([a-z-]+):[ \t]+(?!['"|>&*#])(.*)$/.exec(line);
      if (m && /:\s/.test(m[3])) broken.push(`line ${i + 1}: ${line.trim().slice(0, 80)}`);
    }
    assert.deepEqual(broken, [], 'YAML reads ": " inside a bare scalar as a nested mapping');
  });

  it('uses no tabs, which YAML forbids for indentation', () => {
    const tabbed = lines.map((l, i) => (l.includes('\t') ? i + 1 : 0)).filter(Boolean);
    assert.deepEqual(tabbed, []);
  });

  it('declares what GitHub requires of an action', () => {
    for (const key of ['name:', 'description:', 'runs:']) assert.ok(manifest.includes(key), key);
    assert.match(manifest, /using:\s*['"]?composite/);
  });

  it('keeps the description inside the Marketplace limit', () => {
    const described = /^description:\s*'?(.*?)'?\s*$/m.exec(manifest);
    assert.ok(described, 'no description');
    assert.ok(described[1].length <= 125, `description is ${described[1].length} characters, the limit is 125`);
  });

  it('routes every mode it documents to a script that exists', () => {
    // The router is a chain of `inputs.mode == 'x' && 'x' ||` ending in a default. A mode named in
    // the description but missing from the chain silently runs triage instead, which would be a
    // very confusing way to discover that `mode: check` does nothing.
    const routed = [...manifest.matchAll(/inputs\.mode == '([a-z]+)'/g)].map((m) => m[1]);
    for (const mode of ['report', 'pick', 'check']) assert.ok(routed.includes(mode), `${mode} is not routed`);
  });

  it('offers every check the CI script can actually run', () => {
    const described = /checks:\s*\n\s*description:\s*>-\n([\s\S]*?)\n    default:/.exec(manifest);
    assert.ok(described, 'the checks input has no description');
    for (const check of CHECKS) {
      assert.ok(described[1].includes(check.id), `${check.id} is not offered in the checks input`);
    }
  });
});
