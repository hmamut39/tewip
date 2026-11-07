// Phase 144: the cloud layer, where a mistake is reachable by everybody rather than by whoever is
// already inside the container.
//
// `infra` read Dockerfiles and stopped one layer below where companies actually get hurt. A
// container running as root is a problem for whoever is in the container. A bucket with a public
// ACL, or a security group holding 0.0.0.0/0 open on port 22, is a problem for the whole internet,
// and it is written down in a file in the repository.
//
// Three of these tests are the three false positives real repositories produced, and all three
// were the same shape: reporting the correct practice as the danger.
//
//   - `capabilities: drop: - ALL` is the strongest hardening a pod spec can state. It was reported
//     57 times on Google's microservices-demo as "a capability that undoes the sandbox", every one
//     pointing at the thing the file does right. A list item carries no meaning without its key.
//   - `kind: ServiceAccount` was reported as a workload with no resource limits, because the check
//     asked about the whole file instead of each YAML document in it.
//   - `resources:` filled from a Helm value is a ceiling this cannot see, not a missing one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTerraform } from '../iac/terraform.ts';
import { looksKubernetes, readKubernetes } from '../iac/kubernetes.ts';

const NL = String.fromCharCode(10);
const tf = (...lines: string[]) => readTerraform('main.tf', lines.join(NL));
const k8s = (...lines: string[]) => readKubernetes('deploy.yaml', lines.join(NL));
const rules = (found: Array<{ rule: string }>) => found.map((f) => f.rule).sort();

describe('Terraform', () => {
  it('names a login port open to the whole internet, and says which login', () => {
    const found = tf('resource "aws_security_group" "w" {', '  ingress {', '    from_port = 22', '    to_port = 22', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}');
    assert.deepEqual(rules(found), ['open-to-the-internet']);
    assert.match(found[0].what, /SSH \(port 22\)/);
    assert.equal(found[0].risk, 'high');
  });

  it('says nothing about a port open to a private range', () => {
    assert.deepEqual(tf('resource "aws_security_group" "w" {', '  ingress {', '    from_port = 443', '    to_port = 443', '    cidr_blocks = ["10.0.0.0/8"]', '  }', '}'), []);
  });

  it('reads a public ACL and a guard rail switched off as different things', () => {
    // Different rules on purpose: the report groups by rule and prints the first finding's words
    // as the heading, so two unlike facts under one rule puts a sentence over an item it is not
    // true of.
    const acl = tf('resource "aws_s3_bucket" "b" {', '  acl = "public-read"', '}');
    assert.deepEqual(rules(acl), ['storage-public']);
    const guard = tf('resource "aws_s3_bucket_public_access_block" "b" {', '  block_public_acls = false', '}');
    assert.deepEqual(rules(guard), ['storage-guard-off']);
  });

  it('accepts a public access block that is actually blocking', () => {
    assert.deepEqual(tf('resource "aws_s3_bucket_public_access_block" "b" {', '  block_public_acls = true', '  block_public_policy = true', '}'), []);
  });

  it('wants both halves before calling a policy unbounded', () => {
    const both = tf('resource "aws_iam_policy" "p" {', '  policy = <<EOF', '  { "Action": "*", "Resource": "*" }', 'EOF', '}');
    assert.deepEqual(rules(both), ['permission-unbounded']);
    // A heredoc, which is how Terraform actually writes a policy. Written with escaped quotes
    // (`\"Action\"`) this case matched nothing at all, so it proved nothing: removing the Resource
    // guard left it passing.
    const scoped = tf('resource "aws_iam_policy" "p" {', '  policy = <<EOF', '  { "Action": "*", "Resource": "arn:aws:s3:::one" }', 'EOF', '}');
    assert.deepEqual(scoped, [], 'every action on ONE bucket is a decision somebody made');
  });

  it('ignores a rule that is commented out', () => {
    assert.deepEqual(tf('# ingress {', '#   from_port = 22', '#   cidr_blocks = ["0.0.0.0/0"]', '# }'), []);
  });

  it('names encryption and logging turned off', () => {
    assert.deepEqual(rules(tf('resource "x" "y" {', '  encrypted = false', '  enable_logging = false', '}')), ['no-trail', 'stored-unencrypted']);
  });
});

describe('Kubernetes', () => {
  const workload = (...extra: string[]) => ['apiVersion: apps/v1', 'kind: Deployment', 'spec:', '  template:', '    spec:', '      containers:', '        - name: api', '          image: myorg/api@sha256:abc', '          resources:', '            limits:', '              cpu: 1', ...extra].join(NL);

  it('knows a manifest from any other YAML', () => {
    assert.equal(looksKubernetes('apiVersion: v1' + NL + 'kind: Service'), true);
    assert.equal(looksKubernetes('name: build' + NL + 'on: push'), false, 'a CI workflow is YAML and is none of this command’s business');
  });

  it('names the settings that reach the node', () => {
    const found = readKubernetes('d.yaml', workload('      hostNetwork: true', '          securityContext:', '            privileged: true', '            runAsUser: 0'));
    assert.deepEqual(rules(found), ['host-namespace', 'privileged', 'runs-as-root']);
  });

  it('does not report a dropped capability as an added one', () => {
    // Google's microservices-demo, 57 times. `drop: - ALL` is the hardening, not the hole.
    const dropped = readKubernetes('d.yaml', workload('          capabilities:', '            drop:', '              - ALL'));
    assert.deepEqual(rules(dropped), []);
    const added = readKubernetes('d.yaml', workload('          capabilities:', '            add:', '              - SYS_ADMIN'));
    assert.deepEqual(rules(added), ['dangerous-capability']);
  });

  it('does not let an added capability leak past the end of its list', () => {
    const after = readKubernetes('d.yaml', workload('          capabilities:', '            add:', '              - NET_BIND_SERVICE', '          volumeMounts:', '            - ALL'));
    assert.deepEqual(rules(after), [], 'the second list belongs to volumeMounts, not to add');
  });

  it('asks about limits per document, not per file', () => {
    // A ServiceAccount has no resource limits and never could. Reported at the file level, the
    // finding landed on one.
    // Two workloads, one with a ceiling and one without. Asked per file, the `limits:` in the
    // first hides the second and nothing is reported at all - which is why the file-level version
    // of this test passed with the fix removed: it could not tell the two apart.
    const file = [
      'apiVersion: v1', 'kind: ServiceAccount', 'metadata:', '  name: api',
      '---',
      'apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: has-limits', 'spec:', '  template:', '    spec:', '      containers:', '        - name: a', '          image: a@sha256:b', '          resources:', '            limits:', '              cpu: 1',
      '---',
      'apiVersion: apps/v1', 'kind: StatefulSet', 'metadata:', '  name: no-limits', 'spec:', '  template:', '    spec:', '      containers:', '        - name: b', '          image: c@sha256:d',
    ].join(NL);
    const found = readKubernetes('d.yaml', file);
    assert.deepEqual(rules(found), ['no-limits'], 'exactly one: the StatefulSet, not the Deployment and not the ServiceAccount');
    assert.match(found[0].evidence, /kind: StatefulSet/, 'and it points at the workload that is missing one');
  });

  it('does not call a templated ceiling a missing one', () => {
    const helm = ['apiVersion: apps/v1', 'kind: Deployment', 'spec:', '  template:', '    spec:', '      containers:', '        - name: api', '          image: a@sha256:b', '          resources:', '            {{- toYaml .Values.api.resources | nindent 10 }}'].join(NL);
    assert.deepEqual(rules(readKubernetes('d.yaml', helm)), []);
  });

  it('names an image that does not say what version runs', () => {
    assert.deepEqual(rules(readKubernetes('d.yaml', 'apiVersion: v1' + NL + 'kind: Pod' + NL + 'spec:' + NL + '  resources:' + NL + '    limits:' + NL + '      cpu: 1' + NL + '  image: adservice')), ['mutable-image']);
    assert.deepEqual(rules(readKubernetes('d.yaml', 'apiVersion: v1' + NL + 'kind: Pod' + NL + 'spec:' + NL + '  resources:' + NL + '    limits:' + NL + '      cpu: 1' + NL + '  image: myorg/api:1.4.2')), []);
    assert.deepEqual(rules(readKubernetes('d.yaml', 'apiVersion: v1' + NL + 'kind: Pod' + NL + 'spec:' + NL + '  resources:' + NL + '    limits:' + NL + '      cpu: 1' + NL + '  image: myorg/api@sha256:abcdef')), []);
  });
});
