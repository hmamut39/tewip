// The permissions a coding agent was given in this repository, read from the files that grant them.
//
// `tools.ts` reads what an agent you wrote can call. This reads what an agent you *installed* was
// allowed to do here - Claude Code's `.claude/settings.json` and the project's `.mcp.json`, both of
// which are committed, both of which anybody with write access can change, and neither of which
// turns up in a code review the way a source file does.
//
// Worth saying plainly, because it is the whole reason this is a separate check: a rule written in
// a markdown file is a request to the model. A permission in settings.json is enforced by the
// harness on every tool call. They look equally like configuration and they are not the same kind
// of thing at all, and only one of them is a control an auditor can rely on.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ConfigFinding {
  rule: string;
  file: string;
  /** What is actually written there, so the finding can be checked rather than believed. */
  what: string;
  why: string;
}

export interface McpServer {
  name: string;
  /** Run here, or reached over the network - somebody else's code either way. */
  where: 'this machine' | 'somewhere else';
  detail: string;
}

export interface ConfigScan {
  /** The files that were actually present and readable. */
  read: string[];
  findings: ConfigFinding[];
  servers: McpServer[];
  /** A permission list is an allow-list; a PreToolUse hook is enforced on every call. */
  hasAllowList: boolean;
  hasEnforcedHook: boolean;
}

// Spelled with forward slashes, which is how every other path in a Tewip report is spelled and
// how a reader will search for it. `join` gives a backslash on Windows and the report then names a
// file that does not look like the one in the repository.
const FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];

/**
 * An allow entry that grants a shell with no constraint on the command.
 *
 * `Bash(npm run test:*)` is a decision somebody made. `Bash`, `Bash(*)` and `Bash(*:*)` are the
 * absence of one: they permit `rm -rf`, `curl | sh` and anything else, and they are what people
 * write when the prompts became annoying.
 */
const UNCONSTRAINED = /^(?:Bash|Execute|Shell|Run)(?:\(\s*\*?\s*(?::\s*\*\s*)?\))?$/i;

/** A value written into a committed file that looks like a credential rather than a reference. */
const LOOKS_SECRET = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|API)/i;

const read = (root: string, name: string): { json: Record<string, unknown>; raw: string } | null => {
  const path = join(root, ...name.split('/'));
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    return json && typeof json === 'object' ? { json, raw } : null;
  } catch {
    // A file that does not parse is not a file that grants nothing, and saying so beats guessing.
    return null;
  }
};

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function scanConfig(root: string): ConfigScan {
  const out: ConfigScan = { read: [], findings: [], servers: [], hasAllowList: false, hasEnforcedHook: false };

  for (const name of FILES.slice(0, 2)) {
    const file = read(root, name);
    if (!file) continue;
    out.read.push(name);
    const permissions = (file.json.permissions ?? {}) as Record<string, unknown>;
    const allow = asList(permissions.allow);
    const deny = asList(permissions.deny);
    if (allow.length > 0 || deny.length > 0) out.hasAllowList = true;

    // The gate switched off outright. Nothing else in this file matters as much.
    if (permissions.defaultMode === 'bypassPermissions') {
      out.findings.push({
        rule: 'permissions-bypassed',
        file: name,
        what: '"defaultMode": "bypassPermissions"',
        why: 'every tool call here runs without asking, including the ones that delete, pay or send. This is the approval gate being switched off in a committed file.',
      });
    }
    if (permissions.defaultMode === 'acceptEdits') {
      out.findings.push({
        rule: 'edits-auto-accepted',
        file: name,
        what: '"defaultMode": "acceptEdits"',
        why: 'file edits are applied without asking. Weaker than bypassing everything, and still a person out of the loop on every change to the working tree.',
      });
    }

    for (const entry of allow) {
      if (!UNCONSTRAINED.test(entry.trim())) continue;
      out.findings.push({
        rule: 'shell-unconstrained',
        file: name,
        what: `"allow": [… "${entry}" …]`,
        why: 'this permits any shell command, not a named one. `Bash(npm run test:*)` is a decision; this is the absence of one.',
      });
    }

    if (file.json.enableAllProjectMcpServers === true) {
      out.findings.push({
        rule: 'mcp-auto-trusted',
        file: name,
        what: '"enableAllProjectMcpServers": true',
        why: 'every server in .mcp.json is trusted without being approved, including any added later by anyone who can commit to this repository.',
      });
    }

    const env = (file.json.env ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(env)) {
      // A reference to a variable is fine; a literal is the secret itself, in a committed file.
      if (!LOOKS_SECRET.test(key) || typeof value !== 'string' || value === '' || value.startsWith('$')) continue;
      out.findings.push({
        rule: 'secret-in-settings',
        file: name,
        what: `"env": { "${key}": … }`,
        why: 'a credential written into a file that is committed. Tewip does not print the value; the point is that it is there.',
      });
    }

    const extra = asList(permissions.additionalDirectories);
    if (extra.length > 0) {
      out.findings.push({
        rule: 'boundary-widened',
        file: name,
        what: `"additionalDirectories": [${extra.slice(0, 3).map((d) => `"${d}"`).join(', ')}]`,
        why: 'the agent may read and write outside this project. Whatever is on the other end is inside the blast radius.',
      });
    }

    const hooks = (file.json.hooks ?? {}) as Record<string, unknown>;
    // PreToolUse is the one that can refuse a call. The others observe it after the fact.
    if (Array.isArray(hooks.PreToolUse) && hooks.PreToolUse.length > 0) out.hasEnforcedHook = true;
  }

  const mcp = read(root, '.mcp.json');
  if (mcp) {
    out.read.push('.mcp.json');
    const servers = (mcp.json.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, spec] of Object.entries(servers)) {
      const url = typeof spec?.url === 'string' ? spec.url : '';
      const command = typeof spec?.command === 'string' ? spec.command : '';
      const args = asList(spec?.args).join(' ');
      out.servers.push(
        url
          ? { name, where: 'somewhere else', detail: url.replace(/\/\/[^@]*@/, '//') }
          : { name, where: 'this machine', detail: `${command} ${args}`.trim().slice(0, 90) },
      );
    }
  }
  return out;
}

/** What each rule stops, for a reader deciding which to act on first. */
export const CONFIG_MEANS: Record<string, string> = {
  'permissions-bypassed': 'nothing is asked before any tool call',
  'edits-auto-accepted': 'file edits are applied without asking',
  'shell-unconstrained': 'any shell command is permitted',
  'mcp-auto-trusted': 'tool servers are trusted without approval',
  'secret-in-settings': 'a credential is committed',
  'boundary-widened': 'the agent may work outside this project',
};

/**
 * What the coding agent installed here was permitted to do.
 *
 * Rendered whether or not any tools were found, because the two are independent: a repository with
 * no agent code of its own can still hand Claude Code a shell with no constraint on the command,
 * and that is a finding about this repository either way.
 */
export function configSection(config: ConfigScan): string[] {
  if (config.read.length === 0) return [];
  const lines = ['## What the coding agent here is permitted to do', '', `Read: ${config.read.map((f) => `\`${f}\``).join(', ')}.`, ''];
  if (config.servers.length > 0) {
    lines.push('Tool servers wired into this project:', '');
    for (const s of config.servers) lines.push(`- \`${s.name}\` — runs ${s.where}: \`${s.detail}\``);
    lines.push('');
  }
  if (config.findings.length === 0) {
    lines.push('Nothing in these files switches off an approval, grants an unconstrained shell, trusts a', 'server without approval or commits a credential.', '');
    return lines;
  }
  for (const f of config.findings) {
    lines.push(`- **${f.rule}** — ${CONFIG_MEANS[f.rule] ?? ''}`, `  \`${f.what}\` in \`${f.file}\`. ${f.why}`);
  }
  lines.push('');
  return lines;
}
