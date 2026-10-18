// `npm run channels`: ask every place Tewip is published what it is carrying.
//
// Run by hand after a release, and nightly by .github/workflows/channels.yml, because a channel
// that quietly missed a release is invisible until somebody installs the old one.
//
// Each query is printed alongside its answer. That is not decoration: the reason this check failed
// twice by hand was a wrong question that returned a plausible number, and a question nobody can
// see is a question nobody can correct.
import { readFileSync } from 'node:fs';
import { renderChannels, type ChannelReading } from '../engine/release/channels.ts';

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const pkg = read('package.json');
const server = read('server.json');
const extension = read('extensions/vscode/package.json');

/**
 * Fetches JSON, or says why it could not. Never throws: an outage is a reading, not a crash.
 *
 * Tried twice, because the MCP registry is routinely slow enough to time out once and answer
 * immediately after. An `unverified` that is usually just slowness is an `unverified` people learn
 * to scroll past, and then it stops meaning anything on the day it is real.
 */
async function ask<T>(url: string, init?: RequestInit): Promise<{ body: T | null; problem?: string }> {
  let last = 'the request failed';
  for (const attempt of [1, 2]) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) {
        last = `the registry answered ${res.status}`;
        continue;
      }
      return { body: (await res.json()) as T };
    } catch (error) {
      last = error instanceof Error ? error.message : 'the request failed';
      if (attempt === 1) await new Promise((done) => setTimeout(done, 2000));
    }
  }
  return { body: null, problem: `${last} (tried twice)` };
}

async function npmChannel(): Promise<ChannelReading> {
  const asked = `GET registry.npmjs.org/${pkg.name} -> dist-tags.latest`;
  const { body, problem } = await ask<{ 'dist-tags'?: Record<string, string> }>(`https://registry.npmjs.org/${pkg.name}`);
  const latest = body?.['dist-tags']?.latest;
  return { name: 'npm', expected: pkg.version, actual: latest ?? null, problem: latest ? undefined : problem ?? 'no dist-tags.latest in the answer', asked };
}

async function mcpChannel(): Promise<ChannelReading> {
  // `version=latest` and nothing else. Without it the registry returns a capped version history
  // that comes back missing the newest releases, which is exactly how this check was wrong before.
  const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(server.name)}&version=latest`;
  const asked = 'GET registry.modelcontextprotocol.io/v0/servers?search=<name>&version=latest';
  const { body, problem } = await ask<{ servers?: unknown[] }>(url);
  if (!body || !Array.isArray(body.servers)) {
    return { name: 'MCP registry', expected: server.version, actual: null, problem: problem ?? 'the answer had no servers list', asked };
  }
  const mine = body.servers.map((x: any) => x.server ?? x).filter((x: any) => x?.name === server.name);
  return { name: 'MCP registry', expected: server.version, actual: mine[0]?.version ?? null, problem: mine.length === 0 ? 'the registry lists no server by this name' : undefined, asked };
}

async function openVsxChannel(): Promise<ChannelReading> {
  const asked = `GET open-vsx.org/api/${extension.publisher}/${extension.name} -> version`;
  const { body, problem } = await ask<{ version?: string; error?: string }>(`https://open-vsx.org/api/${extension.publisher}/${extension.name}`);
  return { name: 'Open VSX', expected: extension.version, actual: body?.version ?? null, problem: body?.version ? undefined : body?.error ?? problem, asked };
}

async function marketplaceChannel(): Promise<ChannelReading> {
  const asked = 'POST marketplace.visualstudio.com/_apis/public/gallery/extensionquery (filterType 7)';
  const { body, problem } = await ask<any>('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${extension.publisher}.${extension.name}` }] }], flags: 914 }),
  });
  const version = body?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version ?? null;
  return { name: 'VS Code Marketplace', expected: extension.version, actual: version, problem: version ? undefined : problem ?? 'the gallery returned no version for this extension', asked };
}

const readings = await Promise.all([npmChannel(), mcpChannel(), openVsxChannel(), marketplaceChannel()]);
const { text, behind, unverified } = renderChannels(readings);
console.log(text);

// A channel that is definitively behind is a failure. One that could not be read is not - a
// registry outage is not a release problem - but it is printed above in its own right, and the
// exit code says which of the two happened.
if (behind > 0) process.exit(1);
if (unverified > 0) process.exit(2);
