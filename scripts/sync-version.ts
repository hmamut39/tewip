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
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pinnedTo } from '../engine/agent/server-pinning.ts';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
/** Every file this script writes, so the staging below cannot drift from it. */
const wrote: string[] = [];
const text = readFileSync('server.json', 'utf8');
const server = JSON.parse(text) as { version: string; packages: Array<{ version: string }> };

const was = `${server.version} / ${server.packages.map((p) => p.version).join(', ')}`;
server.version = version;
for (const entry of server.packages) entry.version = version;

// The trailing newline matters: without it every release shows a one-line diff that is only the
// newline coming and going.
writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
wrote.push('server.json');
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
  wrote.push(manifest);
  console.log(`${manifest} ${had} -> ${version}`);
}

// The plugin's MCP server, pinned to the version of the plugin that ships it. OWASP ASI04.
//
// Both plugins declared `npx -y tewip-ai@latest mcp`, which the check added in Phase 225 reports:
// the code behind a tool server fetched at every start is chosen again on each run, by whoever can
// publish to that name. OWASP cites the package that impersonated `postmark-mcp` and began adding a
// hidden BCC of every email in 1.0.16, after a run of clean versions.
//
// Tewip is a harder target than that - published only by CI, with provenance, and staged behind the
// owner's passkey - but `@latest` was still wrong for a different reason: a plugin pinned at 0.87.0
// would run whatever tewip-ai was published afterwards, which is not what a pinned plugin means.
//
// Here rather than written once by hand, because a pin maintained by remembering is a pin that goes
// stale, and a stale pin is worse than none: it reads as deliberate.
for (const config of ['plugin/.mcp.json', 'plugin-standalone/.mcp.json']) {
  const mcp = JSON.parse(readFileSync(config, 'utf8')) as { mcpServers: Record<string, { args?: string[] }> };
  let changed = '';
  for (const server of Object.values(mcp.mcpServers)) {
    const { args, was } = pinnedTo(server.args ?? [], 'tewip-ai', version);
    server.args = args;
    if (was) changed = was;
  }
  if (!changed) throw new Error(`${config} no longer invokes tewip-ai, so nothing was pinned - check it by hand`);
  writeFileSync(config, `${JSON.stringify(mcp, null, 2)}
`);
  wrote.push(config);
  console.log(`${config} ${changed} -> tewip-ai@${version}`);
}

// Stage what this script wrote, from the list it actually wrote rather than a second one.
//
// `npm version` runs this file and then commits whatever is staged. package.json said
// `git add server.json`, so when Phase 193 taught this script to sync the plugin manifests as
// well, those two files were written and never staged - and the 0.85.0 release commit carried a
// plugin that still said 0.84.0. The guard from that same phase caught it in CI and failed the
// publish, which is the system working, on a defect I had put there a day earlier.
//
// Derived from `wrote`, so a file added to this script is staged by it without anybody
// remembering. A hand-kept list beside a hand-kept list is how the first one went stale.
execFileSync('git', ['add', ...wrote], { stdio: 'ignore' });
console.log(`staged: ${wrote.join(', ')}`);
