// What `tewip infra` finds of the Kubernetes Pod Security Standards, measured against the standard.
//
// `infra` is pinned in the corpus for precision - 4 repositories, and it invents nothing. Nothing
// measured what it *misses*, which is the half that matters for a check that tells an IT department
// what their infrastructure permits. The guards half of `agent` had the same gap last week and the
// answer turned out to be 5 of 14.
//
// The ground truth is the Kubernetes project's own Pod Security Standards, which is the right list
// for three reasons: Kubernetes publishes it, it names the exact field and allowed value for each
// control rather than describing an intent, and it does not drift. CIS Kubernetes Benchmark numbers
// were the obvious alternative and were rejected after checking: privileged is 5.2.2 in most
// versions, but allowPrivilegeEscalation is 5.2.5 in v1.5 and 5.2.6 in v1.10 and v1.23, and
// hostPath is 5.2.11 in one implementation and 5.2.12 in another. A ground truth whose identifiers
// move is a ground truth that cannot be cited.
//
// Each control is planted twice, the way eval/access-recall.ts plants the W3C's failures and their
// sufficient techniques: once as the manifest the standard forbids, and once as the manifest the
// standard allows. A checker that cannot tell the forbidden shape from the permitted one teaches
// people to switch it off, and that half found a real bug in `access`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIac } from '../engine/iac/iac-command.ts';

const NL = String.fromCharCode(10);

interface Control {
  /** The profile and field, as the standard names them. */
  control: string;
  /**
   * The rule that should fire, by name.
   *
   * The first version of this counted *any* finding and scored 8 of 8 accused - because every one
   * of these fixtures also trips `no-limits`, which is a true and separate finding about a pod
   * declaring no resource ceiling. Counting output rather than the answer made a correct checker
   * look like it accused every compliant manifest it saw. `null` means this project has no rule
   * for the control at all, which is a miss worth naming rather than hiding.
   */
  rule: string | null;
  profile: 'Baseline' | 'Restricted';
  /** The field the standard restricts, quoted from it. */
  field: string;
  /** A manifest the standard forbids. */
  forbidden: string;
  /** The same manifest in the form the standard allows. */
  allowed: string;
}

const LIMITS = ['      resources:', '        limits:', '          cpu: "500m"', '          memory: 256Mi'].join(NL);

const pod = (name: string, spec: string) =>
  ['apiVersion: v1', 'kind: Pod', 'metadata:', `  name: ${name}`, 'spec:', spec, ''].join(NL);

const CONTROLS: Control[] = [
  {
    control: 'Privileged Containers',
    rule: 'privileged',
    profile: 'Baseline',
    field: 'spec.containers[*].securityContext.privileged',
    forbidden: pod('p1', ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        privileged: true'].join(NL)),
    allowed: pod('p1', ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        privileged: false'].join(NL)),
  },
  {
    control: 'Host Namespaces (network)',
    rule: 'host-namespace',
    profile: 'Baseline',
    field: 'spec.hostNetwork',
    forbidden: pod('p2', ['  hostNetwork: true', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL)),
    allowed: pod('p2', ['  hostNetwork: false', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL)),
  },
  {
    control: 'Host Namespaces (process)',
    rule: 'host-namespace',
    profile: 'Baseline',
    field: 'spec.hostPID',
    forbidden: pod('p3', ['  hostPID: true', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL)),
    allowed: pod('p3', ['  hostPID: false', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL)),
  },
  {
    control: 'HostPath Volumes',
    rule: 'host-path',
    profile: 'Baseline',
    field: 'spec.volumes[*].hostPath',
    forbidden: pod(
      'p4',
      ['  volumes:', '    - name: host', '      hostPath:', '        path: /', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL),
    ),
    allowed: pod(
      'p4',
      ['  volumes:', '    - name: scratch', '      emptyDir: {}', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL),
    ),
  },
  {
    control: 'Capabilities beyond the allowed list',
    rule: 'dangerous-capability',
    profile: 'Baseline',
    field: 'spec.containers[*].securityContext.capabilities.add',
    forbidden: pod(
      'p5',
      ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        capabilities:', '          add: ["SYS_ADMIN"]'].join(NL),
    ),
    // The standard's own allowed value: drop everything, which is what Restricted asks for.
    allowed: pod(
      'p5',
      ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        capabilities:', '          drop: ["ALL"]'].join(NL),
    ),
  },
  {
    control: 'Privilege Escalation',
    rule: 'escalation-allowed',
    profile: 'Restricted',
    field: 'spec.containers[*].securityContext.allowPrivilegeEscalation',
    forbidden: pod(
      'p6',
      ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        allowPrivilegeEscalation: true'].join(NL),
    ),
    allowed: pod(
      'p6',
      ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        allowPrivilegeEscalation: false'].join(NL),
    ),
  },
  {
    control: 'Running as Non-root',
    rule: 'runs-as-root',
    profile: 'Restricted',
    field: 'spec.containers[*].securityContext.runAsNonRoot',
    forbidden: pod(
      'p7',
      ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        runAsUser: 0'].join(NL),
    ),
    allowed: pod(
      'p7',
      ['  containers:', '    - name: app', '      image: nginx:1.27', LIMITS, '      securityContext:', '        runAsNonRoot: true'].join(NL),
    ),
  },
  {
    control: 'Seccomp',
    rule: 'seccomp-off',
    profile: 'Restricted',
    field: 'spec.securityContext.seccompProfile.type',
    forbidden: pod(
      'p8',
      ['  securityContext:', '    seccompProfile:', '      type: Unconfined', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL),
    ),
    allowed: pod(
      'p8',
      ['  securityContext:', '    seccompProfile:', '      type: RuntimeDefault', '  containers:', '    - name: app', '      image: nginx:1.27', LIMITS].join(NL),
    ),
  },
];

export interface Measured {
  control: string;
  profile: string;
  field: string;
  /** Reported on the manifest the standard forbids. */
  noticed: boolean;
  /** Reported on the manifest the standard allows, which would be a false accusation. */
  accused: boolean;
}

/** Whether the rule for this control fired - not whether anything at all did. */
function fired(body: string, rule: string | null): boolean {
  if (rule === null) return false;
  const root = mkdtempSync(join(tmpdir(), 'tewip-infra-recall-'));
  try {
    mkdirSync(join(root, 'k8s'), { recursive: true });
    writeFileSync(join(root, 'k8s', 'pod.yaml'), body, 'utf8');
    return scanIac(root).findings.some((f) => f.rule === rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function measure(): Measured[] {
  return CONTROLS.map((c) => ({
    control: c.control,
    profile: c.profile,
    field: c.field,
    noticed: fired(c.forbidden, c.rule),
    accused: fired(c.allowed, c.rule),
  }));
}

function report(): void {
  const all = measure();
  const noticed = all.filter((m) => m.noticed);
  const accused = all.filter((m) => m.accused);
  const pct = (n: number) => `${((n / all.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      "# infra, measured against Kubernetes' own Pod Security Standards",
      '',
      `${all.length} controls, each planted twice: once as the manifest the standard forbids, once as`,
      'the manifest it allows.',
      '',
      `Controls noticed:      ${noticed.length} of ${all.length} (${pct(noticed.length)})`,
      `Compliant manifests accused: ${accused.length} of ${all.length}`,
      '',
      '## Controls it does not see',
      '',
      ...(all.filter((m) => !m.noticed).length === 0
        ? ['None.']
        : all.filter((m) => !m.noticed).map((m) => `- **${m.control}** (${m.profile}) — \`${m.field}\``)),
      '',
      '## Compliant configuration it reported anyway',
      '',
      ...(accused.length === 0
        ? ['None. The shape the standard allows is not reported as a finding.']
        : accused.map((m) => `- **${m.control}** — the form the standard permits was reported`)),
      '',
      '---',
      '',
      'Ground truth: the Kubernetes project\'s Pod Security Standards, which names the field and the',
      'allowed value for every control. CIS Kubernetes Benchmark numbering was checked first and not',
      'used: allowPrivilegeEscalation is 5.2.5 in one version and 5.2.6 in two others, and hostPath',
      'is 5.2.11 or 5.2.12 depending on the implementation. A ground truth whose identifiers move',
      'cannot be cited. What this does not measure is Terraform, Compose or Dockerfile rules, which',
      'have their own published lists and are not covered here.',
      '',
    ].join(NL),
  );
}

if (process.argv[1]?.includes('infra-recall')) report();
