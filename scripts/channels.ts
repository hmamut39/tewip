// `npm run channels`: ask every place Tewip is published what it is carrying.
//
// Run by hand after a release, and nightly by .github/workflows/channels.yml, because a channel
// that quietly missed a release is invisible until somebody installs the old one.
//
// Each query is printed alongside its answer. That is not decoration: the reason this check failed
// twice by hand was a wrong question that returned a plausible number, and a question nobody can
// see is a question nobody can correct.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderChannels, shippedPathspecs, type ChannelReading } from '../engine/release/channels.ts';

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * How many hours ago this version was cut, from the tag that carries it.
 *
 * The tag is the honest marker: it is the moment the release was asked for, and everything
 * downstream - the build, the staged npm publish, a person approving it, the MCP registry reading
 * npm - happens after it. Without a tag the version has not been released at all, so there is
 * nothing to be late for and nothing is claimed.
 */
function hoursSinceTag(version: string): number | null {
  try {
    const when = execFileSync('git', ['log', '-1', '--format=%cI', `v${version}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!when) return null;
    const at = new Date(when).getTime();
    return Number.isFinite(at) ? (Date.now() - at) / 3_600_000 : null;
  } catch {
    // No such tag: this version was never released, so no channel is behind on it.
    return null;
  }
}
/**
 * Files matching `pathspecs` that changed after the commit which set `version` in `versionFile`.
 *
 * The editor extension carries its own version, bumped only when the extension changes, and the
 * two marketplaces render its README on the listing page. So the version can be right and the
 * listing wrong, and this check used to call that "ok" - which is the stale channel looking
 * exactly like a current one, from the very tool written to stop that happening.
 *
 * Phase 176 found the same hole on npm, which is worse: the extension check was added for a README
 * sentence, but npm carries the product. Seventeen commits sat on main - two of them fixes for
 * `infra` and the standards reader silently reporting nothing on Windows, and a correction to an
 * accuracy figure in the shipped README that overstated Tewip by ten points - and this file printed
 * "Every channel answered, and every one has this release." It was comparing npm's version against
 * package.json's version, which are the same string by construction until somebody bumps it. The
 * question it answered was "has the release reached npm", and the question a person asks it is
 * "does npm have what is in this tree".
 *
 * Returning `{}` is not "nothing changed". A shallow CI checkout has no history to search, and a
 * check that cannot run must say so rather than return a clean answer, which is the mistake this
 * whole file exists to avoid making.
 */
function changedSinceVersionSet(
  versionFile: string,
  version: string,
  pathspecs: string[],
): { changedSince?: string[]; contentProblem?: string; ageHours?: number | null } {
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let setAt = '';
  try {
    setAt = git(['log', '-1', '--format=%H', '-S', `"version": "${version}"`, '--', versionFile]);
  } catch (error) {
    return { contentProblem: `git could not be read (${error instanceof Error ? error.message.split('\n')[0] : 'unknown'})` };
  }
  if (!setAt) return { contentProblem: `no commit in this checkout sets version ${version} in ${versionFile} - a shallow clone cannot answer this` };
  // How old this version is, measured from when it was set rather than from the repository's own
  // release tag. The extension has its own version line and is usually many releases behind the
  // tag that last shipped it, so borrowing the repository's tag age would report a version bumped
  // ten minutes ago as having been missing for 220 hours.
  let ageHours: number | null = null;
  try {
    const when = new Date(git(['log', '-1', '--format=%cI', setAt])).getTime();
    if (Number.isFinite(when)) ageHours = (Date.now() - when) / 3_600_000;
  } catch {
    ageHours = null;
  }
  try {
    return { changedSince: git(['diff', '--name-only', `${setAt}..HEAD`, '--', ...pathspecs]).split('\n').filter(Boolean), ageHours };
  } catch (error) {
    return { contentProblem: `git diff failed (${error instanceof Error ? error.message.split('\n')[0] : 'unknown'})`, ageHours };
  }
}

const pkg = read('package.json');
const server = read('server.json');
const extension = read('extensions/vscode/package.json');
/** Both marketplaces publish the same folder, so they share one answer. */
const extensionContent = changedSinceVersionSet('extensions/vscode/package.json', extension.version, ['extensions/vscode']);

/**
 * npm carries the product, so its content check is the one that matters most. See Phase 176.
 *
 * tsconfig.build.json is the file that decides what reaches `dist/`, and package.json's `files`
 * decides which documents ship beside it. Both are read here and handed to `shippedPathspecs`, so
 * adding a build root extends this check without anybody remembering to.
 *
 * Computed on demand rather than at import so this module can be imported by a test without
 * shelling out to git. The first attempt at guarding this wiring read the file as text and asserted
 * it mentioned `changedSince` - which it did, on the line that destructures it, so stripping the
 * fields from the returned object left the guard green and npm reporting "ok". That is the same
 * vacuous check this project fixed in Phase 171, so the guard is behavioural instead.
 */
let contentCache: ReturnType<typeof changedSinceVersionSet> | null = null;
export function npmContent(): ReturnType<typeof changedSinceVersionSet> {
  if (contentCache === null) {
    const build = read('tsconfig.build.json');
    contentCache = changedSinceVersionSet('package.json', pkg.version, shippedPathspecs(pkg.files ?? [], build.include ?? [], build.exclude ?? []));
  }
  return contentCache;
}

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

/** `content` is injectable so a test can assert the reading carries it, without a git tree. */
export async function npmChannel(content = npmContent()): Promise<ChannelReading> {
  const asked = `GET registry.npmjs.org/${pkg.name} -> dist-tags.latest`;
  const { body, problem } = await ask<{ 'dist-tags'?: Record<string, string> }>(`https://registry.npmjs.org/${pkg.name}`);
  const latest = body?.['dist-tags']?.latest;
  // Only the content fields are taken from `content`. Its `ageHours` measures the version-set
  // commit, which is the right clock for the extension - it has its own version line - but the
  // wrong one here: for npm, "how late is this release" is measured from the tag, as hoursSinceTag
  // explains. Spreading the whole object would quietly swap one for the other.
  const { changedSince, contentProblem } = content;
  return {
    name: 'npm',
    expected: pkg.version,
    ageHours: hoursSinceTag(pkg.version),
    actual: latest ?? null,
    problem: latest ? undefined : problem ?? 'no dist-tags.latest in the answer',
    asked,
    changedSince,
    contentProblem,
  };
}

async function mcpChannel(): Promise<ChannelReading> {
  // `version=latest` and nothing else. Without it the registry returns a capped version history
  // that comes back missing the newest releases, which is exactly how this check was wrong before.
  const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(server.name)}&version=latest`;
  const asked = 'GET registry.modelcontextprotocol.io/v0/servers?search=<name>&version=latest';
  const { body, problem } = await ask<{ servers?: unknown[] }>(url);
  if (!body || !Array.isArray(body.servers)) {
    return { name: 'MCP registry', expected: server.version, ageHours: hoursSinceTag(server.version), actual: null, problem: problem ?? 'the answer had no servers list', asked };
  }
  const mine = body.servers.map((x: any) => x.server ?? x).filter((x: any) => x?.name === server.name);
  return { name: 'MCP registry', expected: server.version, ageHours: hoursSinceTag(server.version), actual: mine[0]?.version ?? null, problem: mine.length === 0 ? 'the registry lists no server by this name' : undefined, asked };
}

async function openVsxChannel(): Promise<ChannelReading> {
  const asked = `GET open-vsx.org/api/${extension.publisher}/${extension.name} -> version`;
  const { body, problem } = await ask<{ version?: string; error?: string }>(`https://open-vsx.org/api/${extension.publisher}/${extension.name}`);
  return { name: 'Open VSX', expected: extension.version, actual: body?.version ?? null, problem: body?.version ? undefined : body?.error ?? problem, asked, ...extensionContent };
}

async function marketplaceChannel(): Promise<ChannelReading> {
  const asked = 'POST marketplace.visualstudio.com/_apis/public/gallery/extensionquery (filterType 7)';
  const { body, problem } = await ask<any>('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${extension.publisher}.${extension.name}` }] }], flags: 914 }),
  });
  const version = body?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version ?? null;
  return { name: 'VS Code Marketplace', expected: extension.version, actual: version, problem: version ? undefined : problem ?? 'the gallery returned no version for this extension', asked, ...extensionContent };
}

// Guarded so a test can import `npmChannel` without this firing four network requests and then
// calling process.exit out from under the test runner.
if (import.meta.main) {
  const readings = await Promise.all([npmChannel(), mcpChannel(), openVsxChannel(), marketplaceChannel()]);
  const { text, behind, unverified, stale } = renderChannels(readings);
  console.log(text);

  // A channel that is definitively behind is a failure. One that could not be read is not - a
  // registry outage is not a release problem - but it is printed above in its own right, and the
  // exit code says which of the three happened.
  if (behind > 0) process.exit(1);
  if (unverified > 0) process.exit(2);
  // The right version carrying the wrong content. Last, because it is the least urgent of the
  // three and the most easily fixed, not because it is acceptable.
  if (stale > 0) process.exit(3);
}
