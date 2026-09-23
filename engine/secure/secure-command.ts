// `tewip secure`: run the scanners a project already has, then say which of their findings matter.
//
// It costs nothing (no model is called), it never prints a credential, and it never claims a
// project is secure: it says exactly what was checked, what was not, and what it decided about each
// finding. "No real risk found" is a statement about these checks, not a certificate.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { auditDependencies } from './deps.ts';
import { scanSecrets, sourceFiles } from './secrets.ts';
import { readAccepted, triageDependency, triageSecret, worstFirst, type SecurityItem } from './triage.ts';

export interface SecureCommand {
  root: string;
  out?: string;
  /** Only the secret scan, for a fast check before a commit. */
  secretsOnly?: boolean;
  /** Exit non-zero when something is a real risk, for a CI gate. */
  gate?: boolean;
}

const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|cs|php|rs|vue|svelte)$/;

export function renderSecurity(items: SecurityItem[], checked: string[], notChecked: string[], root: string): string {
  const real = items.filter((i) => i.verdict === 'real-risk');
  const later = items.filter((i) => i.verdict === 'not-reachable');
  const noise = items.filter((i) => i.verdict === 'noise');
  const accepted = items.filter((i) => i.verdict === 'accepted');

  const lines = ['# Tewip security check', ''];
  lines.push(`Checked: ${checked.length > 0 ? checked.join(', ') : 'nothing ran'}.`);
  if (notChecked.length > 0) lines.push(`**Not checked**: ${notChecked.join('; ')}.`);
  lines.push('');
  lines.push(`${real.length} need someone now · ${later.length} real but not reachable · ${noise.length} noise · ${accepted.length} accepted earlier.`);
  lines.push('');

  const block = (title: string, group: SecurityItem[], explain: string) => {
    if (group.length === 0) return;
    lines.push(`## ${title} (${group.length})`, '', explain, '');
    for (const item of group) {
      lines.push(`- **${item.title}** · ${item.severity}`);
      lines.push(`  - Why: ${item.why}`);
      lines.push(`  - Do: ${item.next}`);
      lines.push(`  - Found by: ${item.source}`);
    }
    lines.push('');
  };

  block('Act on these', real, 'Each one is committed or reachable, and the evidence is beside it.');
  block('Real, but not reachable here', later, 'True of the repository, not of what it runs: fix them on a normal schedule, not tonight.');
  block('Noise', noise, 'A shape without a credential behind it. Listed so you can see nothing was hidden.');
  block('Accepted earlier', accepted, `From ${join('.tewip', 'security-accepted.txt')}, written by a person.`);

  lines.push('---', '');
  lines.push('Tewip never prints a credential: a secret is located, never quoted. To accept a finding,');
  lines.push(`add a line to \`${join(root, '.tewip', 'security-accepted.txt')}\`, for example:`);
  lines.push('```', 'secret tests/fixtures/sample.env:3 - a fixture, not a real key', 'dependency lodash - waiting for the upstream fix', '```');
  lines.push('');
  lines.push('This is not a certificate. It is the result of the checks named above, and nothing else.');
  return lines.join('\n');
}

export async function runSecure(cmd: SecureCommand): Promise<SecurityItem[]> {
  const root = resolve(cmd.root);
  const accepted = readAccepted(root);
  const files = sourceFiles(root);
  const items: SecurityItem[] = [];
  const checked: string[] = ['secrets in the working tree'];
  const notChecked: string[] = [];

  for (const finding of scanSecrets(root, files)) items.push(triageSecret(finding, root, accepted));

  if (!cmd.secretsOnly) {
    const audit = auditDependencies(root);
    checked.push(...audit.ran);
    notChecked.push(...audit.missing);
    const sources = files.filter((f) => CODE.test(f));
    for (const finding of audit.findings) items.push(triageDependency(finding, root, sources, accepted));
  } else {
    notChecked.push('dependencies (--secrets-only was asked for)');
  }
  // A web scan is a different kind of check and needs a running app; it is not pretended here.
  notChecked.push('a running application (no web scan is part of this command yet)');

  items.sort(worstFirst);
  const report = renderSecurity(items, checked, notChecked, root);
  console.log(report);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
    console.log(`\nWritten to ${cmd.out}`);
  }
  return items;
}
