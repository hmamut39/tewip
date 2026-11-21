// Keep server.json's version with package.json's, because nothing else does.
//
// `npm version` knows about package.json and package-lock.json and nothing else. server.json is the
// MCP registry's listing and carries the version twice - its own, and the npm package it points at -
// so every release since 0.49.0 left it behind, and the registry publish failed each time on a guard
// that was doing its job. The guard was right; there was simply no way to pass it except by
// remembering, and remembering is not a mechanism.
//
// Run from the `version` lifecycle script, so it happens on `npm version` whether or not anybody
// thinks of it.
import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const text = readFileSync('server.json', 'utf8');
const server = JSON.parse(text) as { version: string; packages: Array<{ version: string }> };

const was = `${server.version} / ${server.packages.map((p) => p.version).join(', ')}`;
server.version = version;
for (const entry of server.packages) entry.version = version;

// The trailing newline matters: without it every release shows a one-line diff that is only the
// newline coming and going.
writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json ${was} -> ${version}`);

// The Claude Code plugin manifests, which nothing synced and nothing checked.
//
// Found in Phase 193: both declared **0.49.0** while the package was 0.84.0 - thirty-five
// releases, shown to anybody browsing the marketplace. This file already existed because
// server.json had exactly this problem; the plugin manifests were simply never added to it. The
// same defect, in the same shape, one directory over.
for (const manifest of ['plugin/.claude-plugin/plugin.json', 'plugin-standalone/.claude-plugin/plugin.json']) {
  const plugin = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  const had = plugin.version;
  plugin.version = version;
  writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`);
  console.log(`${manifest} ${had} -> ${version}`);
}
