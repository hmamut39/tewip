// What `tewip infra` finds in Terraform, measured against what AWS itself publishes.
//
// Phase 160 measured the Kubernetes half of `infra` against the Pod Security Standards and found
// two real gaps. The Terraform rules - seven of them, covering the settings that actually expose a
// company - had no recall number at all. These are the ones the plan document called "the single
// highest-value week of work available": a public bucket, a security group open to the world, an
// IAM role with `*` on `*`, storage written in the clear, logging switched off.
//
// Ground truth is AWS's own published guidance, named rather than numbered, for the same reason
// Phase 160 refused CIS Kubernetes numbers: the CIS AWS identifiers move between versions. The
// security-group control alone is 4.1 in v1.2.0, 5.02 in v1.4.0 and v2.0, and 6.03 in v6.0. A
// ground truth whose identifiers move cannot be cited, and citing the wrong one is worse than
// citing none.
//
// Each control is planted twice, as eval/infra-recall.ts and eval/access-recall.ts do: once in the
// form the guidance warns against, once in the form it recommends. A checker that cannot tell the
// dangerous shape from the safe one teaches people to switch it off - and in `infra` that half has
// form, because an earlier version of the Kubernetes capability rule reported `drop: ["ALL"]`, the
// strongest hardening a pod spec can state, as a danger 57 times on Google's microservices-demo.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIac } from '../engine/iac/iac-command.ts';

const NL = String.fromCharCode(10);

interface Control {
  /** What AWS calls it. */
  control: string;
  /** Where AWS says it, named rather than numbered. */
  source: string;
  /** The rule that should fire. `null` where this project has none, which is a miss worth naming. */
  rule: string | null;
  /** Terraform in the shape the guidance warns against. */
  risky: string;
  /** The same resource in the shape it recommends. */
  safe: string;
}

const CONTROLS: Control[] = [
  {
    control: 'Block public access to S3 buckets',
    source: 'AWS S3 user guide, "Blocking public access to your Amazon S3 storage"',
    rule: 'storage-public',
    risky: ['resource "aws_s3_bucket_acl" "logs" {', '  bucket = aws_s3_bucket.logs.id', '  acl    = "public-read"', '}'].join(NL),
    safe: ['resource "aws_s3_bucket_acl" "logs" {', '  bucket = aws_s3_bucket.logs.id', '  acl    = "private"', '}'].join(NL),
  },
  {
    control: 'Keep the S3 public access block switched on',
    source: 'AWS S3 user guide, "Configuring block public access settings"',
    rule: 'storage-guard-off',
    risky: [
      'resource "aws_s3_bucket_public_access_block" "logs" {',
      '  bucket                  = aws_s3_bucket.logs.id',
      '  block_public_acls       = false',
      '  ignore_public_acls      = false',
      '  block_public_policy     = false',
      '  restrict_public_buckets = false',
      '}',
    ].join(NL),
    safe: [
      'resource "aws_s3_bucket_public_access_block" "logs" {',
      '  bucket                  = aws_s3_bucket.logs.id',
      '  block_public_acls       = true',
      '  ignore_public_acls      = true',
      '  block_public_policy     = true',
      '  restrict_public_buckets = true',
      '}',
    ].join(NL),
  },
  {
    control: 'No security group open to 0.0.0.0/0 on a remote administration port',
    source: 'AWS VPC user guide, "Security group rules"; the CIS AWS control whose number moves between versions',
    rule: 'open-to-the-internet',
    risky: [
      'resource "aws_security_group" "ssh" {',
      '  ingress {',
      '    from_port   = 22',
      '    to_port     = 22',
      '    protocol    = "tcp"',
      '    cidr_blocks = ["0.0.0.0/0"]',
      '  }',
      '}',
    ].join(NL),
    safe: [
      'resource "aws_security_group" "ssh" {',
      '  ingress {',
      '    from_port   = 22',
      '    to_port     = 22',
      '    protocol    = "tcp"',
      '    cidr_blocks = ["10.0.0.0/8"]',
      '  }',
      '}',
    ].join(NL),
  },
  {
    control: 'No database port open to the whole internet',
    source: 'AWS RDS user guide, "Controlling access with security groups"',
    rule: 'open-to-the-internet',
    risky: [
      'resource "aws_security_group" "db" {',
      '  ingress {',
      '    from_port   = 5432',
      '    to_port     = 5432',
      '    protocol    = "tcp"',
      '    cidr_blocks = ["0.0.0.0/0"]',
      '  }',
      '}',
    ].join(NL),
    safe: [
      'resource "aws_security_group" "db" {',
      '  ingress {',
      '    from_port   = 5432',
      '    to_port     = 5432',
      '    protocol    = "tcp"',
      '    cidr_blocks = ["10.0.1.0/24"]',
      '  }',
      '}',
    ].join(NL),
  },
  {
    control: 'Grant least privilege, not every action on every resource',
    source: 'AWS IAM user guide, "Security best practices in IAM" - apply least-privilege permissions',
    rule: 'permission-unbounded',
    risky: [
      'resource "aws_iam_policy" "admin" {',
      '  policy = jsonencode({',
      '    Statement = [{ "Effect": "Allow", "Action": "*", "Resource": "*" }]',
      '  })',
      '}',
    ].join(NL),
    safe: [
      'resource "aws_iam_policy" "reader" {',
      '  policy = jsonencode({',
      '    Statement = [{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::logs/*" }]',
      '  })',
      '}',
    ].join(NL),
  },
  {
    control: 'Encrypt data at rest',
    source: 'AWS RDS and EBS user guides, "Encrypting Amazon RDS resources" and "Amazon EBS encryption"',
    rule: 'stored-unencrypted',
    risky: ['resource "aws_db_instance" "main" {', '  storage_encrypted = false', '}'].join(NL),
    safe: ['resource "aws_db_instance" "main" {', '  storage_encrypted = true', '}'].join(NL),
  },
  {
    control: 'Keep logging on, so an incident can be answered',
    source: 'AWS CloudTrail user guide, "CloudTrail best practices" - log management and data events',
    rule: 'no-trail',
    risky: ['resource "aws_cloudtrail" "main" {', '  enable_logging = false', '}'].join(NL),
    safe: ['resource "aws_cloudtrail" "main" {', '  enable_logging = true', '}'].join(NL),
  },
];

export interface Measured {
  control: string;
  source: string;
  noticed: boolean;
  accused: boolean;
}

/** Whether the rule for this control fired - not whether anything at all did. */
function fired(body: string, rule: string | null): boolean {
  if (rule === null) return false;
  const root = mkdtempSync(join(tmpdir(), 'tewip-tf-recall-'));
  try {
    mkdirSync(join(root, 'infra'), { recursive: true });
    writeFileSync(join(root, 'infra', 'main.tf'), body, 'utf8');
    return scanIac(root).findings.some((f) => f.rule === rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function measure(): Measured[] {
  return CONTROLS.map((c) => ({
    control: c.control,
    source: c.source,
    noticed: fired(c.risky, c.rule),
    accused: fired(c.safe, c.rule),
  }));
}

function report(): void {
  const all = measure();
  const noticed = all.filter((m) => m.noticed);
  const accused = all.filter((m) => m.accused);
  const pct = (n: number) => `${((n / all.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      "# infra's Terraform rules, measured against what AWS publishes",
      '',
      `${all.length} controls, each planted twice: once in the shape AWS warns against, once in the shape it recommends.`,
      '',
      `Controls noticed:              ${noticed.length} of ${all.length} (${pct(noticed.length)})`,
      `Recommended shapes accused:    ${accused.length} of ${all.length}`,
      '',
      '## Controls it does not see',
      '',
      ...(all.filter((m) => !m.noticed).length === 0 ? ['None.'] : all.filter((m) => !m.noticed).map((m) => `- **${m.control}** — ${m.source}`)),
      '',
      '## Recommended configuration it reported anyway',
      '',
      ...(accused.length === 0 ? ['None. The shape AWS recommends is not reported as a finding.'] : accused.map((m) => `- **${m.control}**`)),
      '',
      '---',
      '',
      "Ground truth: AWS's own guidance, named rather than numbered. CIS AWS Foundations numbers were",
      'checked first and not used - the security-group control alone is 4.1 in v1.2.0, 5.02 in v1.4.0',
      'and v2.0, and 6.03 in v6.0, so an identifier cited here would be wrong for most readers. What',
      'this does not measure is Compose or Dockerfile rules, which have their own published lists.',
      '',
    ].join(NL),
  );
}

if (import.meta.main) report();
