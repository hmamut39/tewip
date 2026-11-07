// What a Kubernetes manifest lets a pod do, read from the file and nothing else.
//
// The settings here are the same few that matter in a Dockerfile, moved up a layer and made
// stronger: a privileged container in a pod spec is privileged on the node, and the node runs
// everybody else's pods too. A manifest is also the one place where the dangerous setting and the
// safe one look almost identical - `privileged: true` sits in the same block as a dozen harmless
// fields, and nobody reads a 300-line YAML file line by line in review.
//
// Read as text rather than parsed as YAML, deliberately. A Helm template is YAML with Go template
// directives spliced through it and is not valid YAML at all; a parser would refuse the file and
// report nothing, which is the worst outcome. Reading the settings as lines means a Helm template
// is still read for the settings it states outright, and the report says which parts of it could
// not be resolved.
import type { IacFinding } from './dockerfile.ts';

const NL = String.fromCharCode(10);
const lineOf = (text: string, index: number): number => text.slice(0, index).split(NL).length;
const shown = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);

/** A file that is a Kubernetes object rather than any other YAML. */
export function looksKubernetes(text: string): boolean {
  return /^\s*kind\s*:\s*\w/m.test(text) && /^\s*apiVersion\s*:/m.test(text);
}

interface Rule {
  rule: string;
  re: RegExp;
  what: string;
  because: string;
  risk: IacFinding['risk'];
}

const RULES: Rule[] = [
  {
    rule: 'privileged',
    re: /^\s*privileged\s*:\s*true\b/gm,
    what: 'a privileged container',
    because: 'privileged turns off nearly every boundary between the container and the node. Whoever is in the container is on the machine, and the machine runs other people’s pods.',
    risk: 'high',
  },
  {
    rule: 'host-namespace',
    re: /^\s*host(?:Network|PID|IPC)\s*:\s*true\b/gm,
    what: 'the pod shares a namespace with the host',
    because: 'the container can see the node’s network, processes or memory as if it were the node. hostNetwork also puts every listening port straight onto the machine, past any service or policy.',
    risk: 'high',
  },
  {
    rule: 'escalation-allowed',
    re: /^\s*allowPrivilegeEscalation\s*:\s*true\b/gm,
    what: 'privilege escalation is explicitly allowed',
    because: 'a process inside can gain more than it was started with, which is the step that turns a small foothold into root',
    risk: 'high',
  },
  {
    rule: 'runs-as-root',
    re: /^\s*runAsUser\s*:\s*0\b/gm,
    what: 'the container runs as root (uid 0)',
    because: 'anything that gets in is root inside, and root inside is one kernel bug from root outside',
    risk: 'high',
  },
  // `dangerous-capability` is NOT in this list: a capability name means the opposite depending on
  // which list it sits in, and this table cannot see that. See `addedCapabilities` below.
  {
    rule: 'host-path',
    re: /^\s*hostPath\s*:/gm,
    what: 'a directory from the node is mounted in',
    because: 'the container reads and writes the machine’s own filesystem. Mounted at / or /var/run it is the node; mounted at the docker socket it is every container on it.',
    risk: 'high',
  },
];

/** The mutable tag, which is how a manifest stops describing what is running. */
const MUTABLE_IMAGE = /^\s*image\s*:\s*["']?([^"'\s]+:latest|[^"'\s:]+)["']?\s*$/gm;

/**
 * Capabilities being **added**, which is the opposite of the ones being dropped.
 *
 * `- ALL` under `drop:` is the strongest hardening a pod spec can state, and the first version of
 * this reported it as "a capability that undoes the sandbox" - 57 times on Google's own
 * microservices-demo, every one of them pointing at the thing the file does right. A list item
 * carries no meaning on its own; the key above it does, so the key has to be found.
 */
function addedCapabilities(text: string): Array<{ index: number; name: string; line: string }> {
  const lines = text.split(NL);
  const out: Array<{ index: number; name: string; line: string }> = [];
  let adding = false;
  let at = 0;
  for (const line of lines) {
    const key = /^\s*(add|drop)\s*:\s*$/.exec(line);
    if (key) adding = key[1] === 'add';
    // Any other key at this level ends the list, so a later `- ALL` is not still inside `add:`.
    else if (/^\s*[\w.-]+\s*:/.test(line)) adding = false;
    else if (adding) {
      const item = /^\s*-\s*["']?([A-Z_]+)["']?\s*$/.exec(line);
      if (item && /^(?:SYS_ADMIN|SYS_PTRACE|SYS_MODULE|SYS_BOOT|NET_ADMIN|NET_RAW|DAC_READ_SEARCH|ALL)$/.test(item[1])) {
        out.push({ index: at, name: item[1], line });
      }
    }
    at += line.length + 1;
  }
  return out;
}

export function readKubernetes(file: string, text: string): IacFinding[] {
  const out: IacFinding[] = [];
  const add = (line: number, rule: string, what: string, because: string, evidence: string, risk: IacFinding['risk']) =>
    out.push({ file, line, rule, what, because, evidence: shown(evidence), risk });

  for (const { rule, re, what, because, risk } of RULES) {
    for (const m of text.matchAll(re)) add(lineOf(text, m.index ?? 0), rule, what, because, m[0], risk);
  }

  for (const cap of addedCapabilities(text)) {
    add(
      lineOf(text, cap.index),
      'dangerous-capability',
      'a capability is added that undoes the sandbox',
      'SYS_ADMIN is close to root, SYS_PTRACE reads other processes’ memory, SYS_MODULE loads kernel code, NET_RAW forges packets, and ALL is all of them',
      cap.line,
      'high',
    );
  }

  for (const m of text.matchAll(MUTABLE_IMAGE)) {
    const ref = m[1];
    // A digest is immutable and is the thing to encourage; a registry host with a port is not a tag.
    if (ref.includes('@sha256:') || /^[\w.-]+:\d+$/.test(ref)) continue;
    add(
      lineOf(text, m.index ?? 0),
      'mutable-image',
      `the image is pinned to ${ref.endsWith(':latest') ? '`latest`' : 'no tag at all'}`,
      'what runs tomorrow is whatever was pushed to that tag, so this file stops describing the cluster. It also means a rollback does not roll anything back.',
      m[0],
      'medium',
    );
  }

  // A pod with no ceiling can take the node down on its own, and takes its neighbours with it.
  //
  // Per YAML document, not per file. One file commonly holds a ServiceAccount, a Service and a
  // Deployment separated by `---`; asking "does this file contain a workload, and does this file
  // contain limits" then reports at the first `kind:` in it, which on Google's microservices-demo
  // was a ServiceAccount - an object that has no resource limits and never could.
  let offset = 0;
  for (const doc of text.split(/^---\s*$/m)) {
    const start = offset;
    offset += doc.length + 4;
    const kind = /^\s*kind\s*:\s*(?:Deployment|StatefulSet|DaemonSet|Pod|Job|CronJob)\b.*$/m.exec(doc);
    if (!kind || /^\s*limits\s*:/m.test(doc)) continue;
    // A `resources:` block whose contents come from a template is not a missing ceiling - it is a
    // ceiling this cannot see, and the two must not be reported as the same thing. Google's chart
    // writes `resources:` then `{{- toYaml .Values.adService.resources | nindent 10 }}`, and the
    // limits are in values.yaml where nothing here reads them.
    if (/^\s*resources\s*:/m.test(doc) && /\{\{/.test(doc)) continue;
    add(
      lineOf(text, start + (kind.index ?? 0)),
      'no-limits',
      'no resource limits are set on this workload',
      'one container looping can take the memory or CPU of the whole node, and the pods evicted will be somebody else’s',
      kind[0],
      'medium',
    );
  }
  return out;
}

/** What reading a manifest cannot settle. */
export const KUBERNETES_NOT_CHECKED = [
  'anything a Helm value supplies: a template is read for what it states outright, not for what is filled in',
  'what the cluster is actually running, which only the cluster knows',
  'RBAC bindings, network policies and admission controllers, which may forbid what a manifest asks for',
  'the image contents, and therefore what runs as the entrypoint',
];
