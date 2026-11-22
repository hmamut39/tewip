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
import { lf } from '../lines.ts';
import { dirname, join, relative, resolve } from 'node:path';
import { isDockerfile, readDockerfile, type IacFinding } from './dockerfile.ts';
import { readCompose } from './compose.ts';
import { readTerraform, TERRAFORM_NOT_CHECKED } from './terraform.ts';
import { KUBERNETES_NOT_CHECKED, looksKubernetes, readKubernetes } from './kubernetes.ts';
import { ships as shipsFrom } from '../ships.ts';

export interface IacCommand {
  root: string;
  out?: string;
  /** Exit non-zero when something that ships is high risk, for a CI gate. */
  gate?: boolean;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.cache']);

const COMPOSE = /^(docker-)?compose.*\.ya?ml$/i;
const TERRAFORM = /\.tf$/i;
// Any YAML may be a Kubernetes object; the file decides, not its name - a manifest is as likely to
// be called `deploy.yaml` or to sit in a Helm `templates/` folder as to say kubernetes anywhere.
const YAML = /\.ya?ml$/i;
/** Paths whose contents configure somebody's laptop or a test rig, not production. */

export interface IacScan {
  findings: Array<IacFinding & { ships: boolean }>;
  dockerfiles: number;
  composeFiles: number;
  terraformFiles: number;
  manifests: number;
  notChecked: string[];
}

export function scanIac(root: string): IacScan {
  const findings: Array<IacFinding & { ships: boolean }> = [];
  let dockerfiles = 0;
  let composeFiles = 0;
  let terraformFiles = 0;
  let manifests = 0;
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
      const isDocker = isDockerfile(entry);
      const isCompose = COMPOSE.test(entry);
      const isTerraform = TERRAFORM.test(entry);
      // A compose file is also YAML, so it is claimed first and never read twice.
      const maybeManifest = !isCompose && YAML.test(entry);
      if (!isDocker && !isCompose && !isTerraform && !maybeManifest) continue;
      if (info.size > 1_000_000) continue;
      let source: string;
      try {
        // Normalised to LF before any rule sees it, which is the one place that can be done once.
        //
        // Phase 169: every rule here is anchored with `/^\s*.../gm`, and on a CRLF file that is
        // wrong twice over. JavaScript's `m` flag treats a lone `\r` as a line terminator, so `^`
        // matches between the `\r` and the `\n`; and `\s` matches a newline, so `^\s*` then runs
        // forward across the break and matches content on the *next* line while reporting the
        // index of the previous one. Every Kubernetes finding came back one line early on Windows,
        // and `readCompose` missed `cap_add` entirely because `.` does not match `\r`.
        //
        // Fixing it per rule would mean getting `\s` versus `[ \t]` right in every pattern written
        // from here on, and being wrong would be silent. Measured by `eval/crlf-parity.ts`.
        source = lf(readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      const rel = relative(root, full).split(String.fromCharCode(92)).join('/');
      // Whether a .yaml file is a Kubernetes object is decided by what is in it, not by its name:
      // a manifest is as likely to be `deploy.yaml` or a Helm template as to say kubernetes
      // anywhere, and a CI workflow is YAML too and is none of this command's business.
      const isManifest = maybeManifest && looksKubernetes(source);
      if (maybeManifest && !isManifest) continue;
      const ships = shipsFrom(rel);
      const read = isCompose ? readCompose : isTerraform ? readTerraform : isManifest ? readKubernetes : readDockerfile;
      if (isCompose) composeFiles += 1;
      else if (isTerraform) terraformFiles += 1;
      else if (isManifest) manifests += 1;
      else dockerfiles += 1;
      for (const f of read(rel, source)) findings.push({ ...f, ships });
    }
  };
  walk(root);
  const notChecked = [
    'vulnerabilities in the base images: that needs a registry and a feed, and this command reaches neither',
    // Phase 212. A USER set inside a base image is inherited and is invisible from here, so
    // "this image has no USER" is read from this file and not from the image it pulls. A USER set
    // in an earlier stage of the same file **is** followed, because that is readable.
    'what a base image sets for itself: a USER inside `FROM registry/image` is inherited and cannot be read from a Dockerfile, so a "runs as root" finding on a pulled base is about what this file does not set, not about what the image does',
    'anything that is actually running: this reads files, not a cluster and not a cloud account',
    ...(terraformFiles > 0 ? TERRAFORM_NOT_CHECKED : ['Terraform: no .tf file was found here']),
    ...(manifests > 0 ? KUBERNETES_NOT_CHECKED : ['Kubernetes: no file here declares an apiVersion and a kind']),
    'CloudFormation, Pulumi, Bicep and ARM templates: not read',
  ];
  return { findings, dockerfiles, composeFiles, terraformFiles, manifests, notChecked };
}

export function renderIac(scan: IacScan): string {
  const shipping = scan.findings.filter((f) => f.ships);
  const dev = scan.findings.filter((f) => !f.ships);
  const high = shipping.filter((f) => f.risk === 'high');
  const lines = [
    '# What these containers let in',
    '',
    `Read ${scan.dockerfiles} Dockerfile(s), ${scan.composeFiles} compose file(s), ${scan.terraformFiles} Terraform file(s) and ${scan.manifests} Kubernetes manifest(s).`,
    '',
  ];
  if (scan.findings.length === 0 && scan.dockerfiles + scan.composeFiles + scan.terraformFiles + scan.manifests > 0) {
    lines.push('Nothing matched the rules below. That is not a clean bill of health: the list of what was not checked is at the end, and it is longer than the list of what was.', '');
  }

  const group = (title: string, items: typeof scan.findings, note: string) => {
    if (items.length === 0) return;
    lines.push(`## ${title} — ${items.length}`, '', note, '');
    // Grouped by the sentence, not only by the rule id.
    //
    // One rule can say two different things, and `runs-as-root` says both "this image has no USER"
    // and "the last USER in this image is root". Grouping on the rule alone printed the first of
    // those as the heading over all of them, so immich's `server/Dockerfile.dev:43` was listed
    // under **"this image has no USER"** with the line `USER root` beside it as its evidence - a
    // heading and a quote that contradict each other, about a finding that was correct.
    //
    // Found in Phase 212 by reading what `infra` says about a real repository rather than counting
    // what it found. The counts do not move: this changes which sentence each finding is filed
    // under, which is the sentence a reader checks it against.
    const byRule = new Map<string, typeof items>();
    const NUL = String.fromCharCode(0);
    for (const f of items) byRule.set(`${f.rule}${NUL}${f.what}`, [...(byRule.get(`${f.rule}${NUL}${f.what}`) ?? []), f]);
    for (const [key, group_] of byRule) {
      const rule = key.split(NUL)[0];
      // Trimmed before the full stop is added: a `because` that already ends in one printed '..'
      lines.push(`### ${group_[0].what} (${group_.length}) \`${rule}\``, '', group_[0].because.replace(/\.$/, '') + '.', '');
      for (const f of group_.slice(0, 8)) lines.push(`- \`${f.file}:${f.line}\` — \`${f.evidence.replace(/`/g, "'")}\``);
      if (group_.length > 8) lines.push(`- …and ${group_.length - 8} more`);
      lines.push('');
    }
  };
  group('In what ships', shipping, 'These are in files that ship - images, compose files, Terraform and manifests - outside test, docs and devcontainer paths.');
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

