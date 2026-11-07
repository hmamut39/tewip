// `tewip contract`: what this change breaks for the clients already calling your API.
//
// The comparison is against git, because that is where the previous version of the contract is.
// Nothing is fetched, no service is called, and the answer is the same every time it is run.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanSourceFiles } from '../walk.ts';
import { readYaml } from './yaml-lite.ts';
import { BREAKS_WHO, compareOpenApi, OPENAPI_NOT_CHECKED, type Break } from './openapi.ts';

const NL = String.fromCharCode(10);

export interface ContractCommand {
  root: string;
  /** What to compare against. A git ref; `HEAD` by default. */
  since?: string;
  out?: string;
  /** Exit non-zero when anything would break a caller. */
  gate?: boolean;
}

export interface ContractScan {
  since: string;
  /** Per file: what broke, or why it could not be compared. */
  files: Array<{ file: string; breaks: Break[]; unreadable?: string }>;
  checked: number;
  /** Files that look like a description but have no previous version to compare against. */
  isNew: string[];
}

const DESCRIPTION = /\.(?:ya?ml|json)$/i;
const NOT_SHIPPED = /(?:^|[\\/])(?:node_modules|\.git|dist|build|out|vendor|test|tests|__tests__|fixtures?|examples?)[\\/]/i;

/** A file that declares itself an API description, rather than one whose name suggests it. */
function looksOpenApi(text: string): boolean {
  return /^\s*["']?(?:openapi|swagger)["']?\s*:/m.test(text) && /^\s*["']?paths["']?\s*:/m.test(text);
}

const git = (args: string[], cwd: string): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

export function scanContracts(cmd: ContractCommand): ContractScan {
  const since = cmd.since ?? 'HEAD';
  const out: ContractScan = { since, files: [], checked: 0, isNew: [] };
  const found = scanSourceFiles(cmd.root, 20_000, (f) => DESCRIPTION.test(f));
  for (const path of found.files) {
    const where = relative(cmd.root, path).replace(/\\/g, '/');
    if (NOT_SHIPPED.test(where)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!looksOpenApi(text)) continue;
    out.checked += 1;
    const previous = git(['show', `${since}:${where}`], cmd.root);
    if (previous === null) {
      out.isNew.push(where);
      continue;
    }
    const before = parse(previous);
    const after = parse(text);
    if ('unreadable' in before) {
      out.files.push({ file: where, breaks: [], unreadable: `the version at ${since} could not be read: ${before.unreadable} (line ${before.line})` });
      continue;
    }
    if ('unreadable' in after) {
      out.files.push({ file: where, breaks: [], unreadable: `this version could not be read: ${after.unreadable} (line ${after.line})` });
      continue;
    }
    const breaks = compareOpenApi(before.value, after.value);
    if (breaks.length > 0) out.files.push({ file: where, breaks });
  }
  return out;
}

/** JSON exactly, YAML through the block reader, and a refusal rather than a half-read either way. */
function parse(text: string): ReturnType<typeof readYaml> {
  if (/^\s*\{/.test(text)) {
    try {
      return { value: JSON.parse(text) };
    } catch (error) {
      return { unreadable: `it is not valid JSON (${error instanceof Error ? error.message.slice(0, 60) : 'unknown'})`, line: 1 };
    }
  }
  return readYaml(text);
}

export function renderContract(scan: ContractScan): string {
  const all = scan.files.flatMap((f) => f.breaks);
  const lines = ['# What this change breaks for the callers', ''];

  if (scan.checked === 0) {
    return [
      '# What this change breaks for the callers',
      '',
      'No API description was found. A file counts here when it has both an `openapi` (or `swagger`)',
      'key and a `paths` key - the name is not enough, because half the YAML in a repository is',
      'something else.',
      '',
      'This reads OpenAPI 2 and 3, in YAML or JSON. GraphQL, protobuf and gRPC are not read.',
    ].join(NL);
  }

  lines.push(
    `${scan.checked} API description(s), compared against \`${scan.since}\`. Nothing was fetched and no service was called.`,
    '',
  );
  if (all.length === 0) {
    lines.push('Nothing here breaks a caller that works today.', '');
  } else {
    lines.push(`**${all.length} change(s) would break a caller.**`, '');
    for (const file of scan.files) {
      if (file.breaks.length === 0) continue;
      lines.push(`### \`${file.file}\``, '');
      const byKind = new Map<string, Break[]>();
      for (const b of file.breaks) byKind.set(b.kind, [...(byKind.get(b.kind) ?? []), b]);
      for (const [kind, group] of byKind) {
        lines.push(`**${kind}** — ${BREAKS_WHO[group[0].kind]}`, '');
        for (const b of group.slice(0, 12)) lines.push(`- \`${b.where}\` — ${b.what}`);
        if (group.length > 12) lines.push(`- …and ${group.length - 12} more`);
        lines.push('');
      }
    }
  }

  const unreadable = scan.files.filter((f) => f.unreadable);
  if (unreadable.length > 0) {
    lines.push(
      '## Not compared',
      '',
      'These were left alone rather than half-read. A partly parsed description invents removed',
      'fields, and a reader who is told a field vanished because a reader lost its place stops',
      'trusting everything else on the page.',
      '',
      ...unreadable.map((f) => `- \`${f.file}\` — ${f.unreadable}`),
      '',
      'If the same description is also published as JSON, point this at that file instead: JSON is',
      'parsed exactly, and the YAML reader here is a small one on purpose - Tewip has two runtime',
      'dependencies and a tool that reports on other people’s dependency trees should stand on its own.',
      '',
    );
  }
  if (scan.isNew.length > 0) {
    lines.push(`## New here`, '', `No previous version at \`${scan.since}\`, so nothing to compare: ${scan.isNew.map((f) => `\`${f}\``).join(', ')}.`, '');
  }

  lines.push('## What this does not check', '', ...OPENAPI_NOT_CHECKED.map((n) => `- ${n}`), '', 'Run `tewip contract` again and you get the same answer.', '');
  return lines.join(NL);
}

export function runContract(cmd: ContractCommand): { report: string; breaks: number } {
  const scan = scanContracts(cmd);
  const report = renderContract(scan);
  if (cmd.out) writeFileSync(cmd.out, report, 'utf8');
  else console.log(report);
  const breaks = scan.files.reduce((n, f) => n + f.breaks.length, 0);
  if (cmd.gate && breaks > 0) process.exitCode = 1;
  return { report, breaks };
}

/** Exported for the portfolio column, which asks the same question across many checkouts. */
export const isApiDescription = looksOpenApi;
export const gitAt = (root: string, ref: string, file: string): string | null => git(['show', `${ref}:${file}`], root);
export const specPath = (root: string, file: string) => join(root, file);
export { existsSync };
