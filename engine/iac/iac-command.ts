// `tewip infra`: what the containers and the infrastructure files let in.
//
// Rules-first, no network, no registry, no vulnerability feed - the same bargain as the rest of
// Tewip. It reports what is certain from the text and says what it did not look at, which for
// this command is most of the category: no image CVEs, no Kubernetes, no cloud account.
//
// The one judgement it makes is about where a file lives. A `.devcontainer` that runs privileged
// is a development environment, and reporting it beside a privileged production service would
// teach a reader to skim both. It is still shown, below, because somebody has to decide that -
// the same shape as a credential in a test file.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { readDockerfile, type IacFinding } from './dockerfile.ts';
import { readCompose } from './compose.ts';

export interface IacCommand {
  root: string;
  out?: string;
  /** Exit non-zero when something that ships is high risk, for a CI gate. */
  gate?: boolean;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.cache']);
const DOCKERFILE = /^dockerfile($|[.-])/i;
const COMPOSE = /^(docker-)?compose.*\.ya?ml$/i;
/** Paths whose contents configure somebody's laptop or a test rig, not production. */
const NOT_SHIPPED = /(^|\/)(\.devcontainer|\.github|test|tests|e2e|examples?|docs?|fixtures?|sample)s?(\/|$)/i;

export interface IacScan {
  findings: Array<IacFinding & { ships: boolean }>;
  dockerfiles: number;
  composeFiles: number;
  notChecked: string[];
}

export function scanIac(root: string): IacScan {
  const findings: Array<IacFinding & { ships: boolean }> = [];
  let dockerfiles = 0;
  let composeFiles = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      const isDockerfile = DOCKERFILE.test(entry);
      const isCompose = COMPOSE.test(entry);
      if (!isDockerfile && !isCompose) continue;
      if (info.size > 1_000_000) continue;
      let source: string;
      try {
        source = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(root, full).split(String.fromCharCode(92)).join('/');
      if (isCompose) composeFiles += 1;
      else dockerfiles += 1;
      const ships = !NOT_SHIPPED.test(rel);
      for (const f of (isCompose ? readCompose : readDockerfile)(rel, source)) findings.push({ ...f, ships });
    }
  };
  walk(root);
  const notChecked = [
    'vulnerabilities in the base images: that needs a registry and a feed, and this command reaches neither',
    'Kubernetes manifests and Helm charts: not read, because Tewip has not been measured against real ones',
    'Terraform and other cloud definitions: not read yet',
    'anything that is actually running: this reads files, not a cluster',
  ];
  return { findings, dockerfiles, composeFiles, notChecked };
}

export function renderIac(scan: IacScan): string {
  const shipping = scan.findings.filter((f) => f.ships);
  const dev = scan.findings.filter((f) => !f.ships);
  const high = shipping.filter((f) => f.risk === 'high');
  const lines = [
    '# What these containers let in',
    '',
    `Read ${scan.dockerfiles} Dockerfile(s) and ${scan.composeFiles} compose file(s).`,
    '',
  ];
  if (scan.findings.length === 0 && scan.dockerfiles + scan.composeFiles > 0) {
    lines.push('Nothing matched the rules below. That is not a clean bill of health: the list of what was not checked is at the end, and it is longer than the list of what was.', '');
  }

  const group = (title: string, items: typeof scan.findings, note: string) => {
    if (items.length === 0) return;
    lines.push(`## ${title} — ${items.length}`, '', note, '');
    const byRule = new Map<string, typeof items>();
    for (const f of items) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    for (const [rule, group_] of byRule) {
      lines.push(`### ${group_[0].what} (${group_.length}) \`${rule}\``, '', group_[0].because + '.', '');
      for (const f of group_.slice(0, 8)) lines.push(`- \`${f.file}:${f.line}\` — \`${f.evidence.replace(/`/g, "'")}\``);
      if (group_.length > 8) lines.push(`- …and ${group_.length - 8} more`);
      lines.push('');
    }
  };
  group('In what ships', shipping, 'These are in images and compose files outside test, docs and devcontainer paths.');
  group('In development and test setups', dev, 'A devcontainer that runs privileged is usually deliberate. Shown so somebody can decide, not because it is wrong.');

  lines.push('## What was not checked', '');
  for (const n of scan.notChecked) lines.push(`- ${n}`);
  lines.push('', 'This is a short list of certain things, not a container security review.', '');
  if (high.length > 0) lines.push(`**${high.length} high-risk finding(s) in what ships.**`, '');
  lines.push('No model was called and nothing was fetched.');
  return lines.join('\n');
}

export function runIac(cmd: IacCommand): { report: string; high: number } {
  const root = resolve(cmd.root);
  const scan = scanIac(root);
  const report = renderIac(scan);
  console.log(report);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  const high = scan.findings.filter((f) => f.ships && f.risk === 'high').length;
  if (cmd.gate && high > 0) process.exitCode = 1;
  return { report, high };
}

