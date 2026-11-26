// OWASP ASI04, Agentic Supply Chain: where the agent's tool servers come from.
//
// `claude-config.ts` next door lists the MCP servers a project configures. This asks the question
// that list cannot answer on its own - whether the code behind each one is pinned, or fetched fresh
// from somewhere that can change between one start-up and the next.
//
// The failure mode is the one OWASP cites for ASI04 by name. A package impersonating `postmark-mcp`
// sat on npm through a run of clean versions and then, in 1.0.16, began adding a hidden BCC of every
// email it sent to an address the author controlled. Nothing about the configuration that installed
// it changed. `npx -y postmark-mcp` fetches whatever is newest at every start, and `-y` answers the
// one prompt that would have asked a person about it, so an agent configured that way picked up
// 1.0.16 the next time it ran.
//
// Pinning is the control OWASP names for this - by version or by content hash - and it is a property
// of a line in a config file rather than an inference about behaviour, which is why this check can
// be precise in a way the flow checks cannot. A lockfile does not cover it: these servers are not
// dependencies of the project, they are fetched by the agent harness at run time.
//
// What this is not: a judgement about whether a particular server is trustworthy. Tewip does not
// know that and cannot. The finding is that the choice is being made again on every start, by
// whoever can publish to that name.

export interface ServerSource {
  name: string;
  /** How the code gets here, in words a reader can check against the line. */
  how: 'fetched at every start' | 'pinned' | 'from this project' | 'somebody else’s service';
  /** What is actually written in the config, so the finding can be checked rather than believed. */
  what: string;
  /** The pin, where there is one - a version or a digest. */
  pin: string | null;
  why: string;
}

/** A version or digest pinned on a package or image reference. */
const PINNED = [
  // npm: `pkg@1.2.3`, `@scope/pkg@1.2.3`. A leading `@` is the scope, so the version separator is
  // the `@` that follows a name character.
  /[\w\-.\]]@(\d[\w\-.]*)/,
  // Python: `pkg==1.2.3`, and uv's `pkg@1.2.3`.
  /==\s*(\d[\w\-.]*)/,
  // A container image by digest, which is the strongest of the three.
  /@(sha256:[0-9a-f]{16,})/i,
];

/**
 * A tag that looks like a pin and is not one.
 *
 * `@latest` and `:latest` are the explicit form of the default, and a reader scanning a config sees
 * a version-shaped string after an `@` and moves on. `next`, `beta` and `canary` are the same
 * promise with a different name.
 */
const MOVING_TAG = /[@:](latest|next|beta|canary|edge|main|master|dev|nightly)\b/i;

/** The runners that fetch a package when they are run, rather than running one already here. */
const FETCHES = /^(?:npx|pnpm\s+dlx|yarn\s+dlx|bunx|uvx|pipx)\b|^(?:pipx|uv)\s+run\b|^docker\s+run\b/;

/** Code that is in this repository, reviewed the way the rest of it is. */
const LOCAL = /^(?:node|python3?|deno|bun|\.\/|\.\.\/|\/|[A-Za-z]:\\)/;

/**
 * Where one configured server's code comes from.
 *
 * `command` and `args` are the two fields an MCP stdio server is declared with; `url` is the
 * remote form. The whole line is kept in `what`, because a finding about a config file is only
 * useful if the reader can go and look at the line it is about.
 */
export function sourceOf(name: string, command: string, args: string, url: string): ServerSource {
  const line = `${command} ${args}`.trim();
  if (url) {
    return {
      name,
      how: 'somebody else’s service',
      what: url.replace(/\/\/[^@]*@/, '//'),
      pin: null,
      why:
        'this server is reached over the network, so there is no version here to pin: whatever is answering that ' +
        'address decides what the tools do. Pinning is not the control for this one - knowing who runs it is.',
    };
  }

  if (!FETCHES.test(line)) {
    return {
      name,
      how: LOCAL.test(line) || line === '' ? 'from this project' : 'pinned',
      what: line,
      pin: null,
      why:
        'the code behind this server is already here and is reviewed the way the rest of the repository is, so a ' +
        'start-up does not go and get a new copy of it.',
    };
  }

  const moving = MOVING_TAG.exec(line);
  const pinned = moving ? null : PINNED.map((re) => re.exec(line)).find(Boolean);
  if (pinned) {
    return {
      name,
      how: 'pinned',
      what: line,
      pin: pinned[1],
      why: `this server is fetched at start-up, but to ${pinned[1]} specifically, so a new release does not change what the agent runs.`,
    };
  }

  return {
    name,
    how: 'fetched at every start',
    what: line,
    pin: null,
    why:
      `${moving ? `\`${moving[1]}\` is the default wearing a version's clothes: it` : 'with no version pinned, this'} ` +
      'fetches whatever is newest every time the agent starts, so whoever can publish to that name decides what the ' +
      'agent runs next. OWASP cites this for ASI04: a package impersonating `postmark-mcp` ran clean for several ' +
      'versions and then, in 1.0.16, started adding a hidden BCC of every email to its author. No configuration ' +
      'changed. Pin it to a version or a digest, or vendor it.',
  };
}

/**
 * The same invocation with a package pinned to a version.
 *
 * A pure function because the alternative is a transform living inside a release script, where the
 * only way to find out whether it still works is to cut a release. `scripts/sync-version.ts` calls
 * this on every `npm version` so Tewip's own plugin cannot drift back to `@latest`, which is where
 * it was until the check in this file was pointed at it.
 */
export function pinnedTo(args: string[], pkg: string, version: string): { args: string[]; was: string | null } {
  let was: string | null = null;
  const out = args.map((arg) => {
    if (arg !== pkg && !arg.startsWith(`${pkg}@`)) return arg;
    was = arg;
    return `${pkg}@${version}`;
  });
  return { args: out, was };
}

/** Every configured server, with where its code comes from. */
export function sourcesOf(servers: Array<{ name: string; command?: string; args?: string; url?: string }>): ServerSource[] {
  return servers.map((s) => sourceOf(s.name, s.command ?? '', s.args ?? '', s.url ?? ''));
}
