// `tewip secure`: run the scanners a project already has, then say which of their findings matter.
//
// It costs nothing (no model is called), it never prints a credential, and it never claims a
// project is secure: it says exactly what was checked, what was not, and what it decided about each
// finding. "No real risk found" is a statement about these checks, not a certificate.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { auditDependencies } from './deps.ts';
import { scanSecrets, sourceFiles } from './secrets.ts';
import { readAccepted, triageDependency, triageSecret, triageWeb, worstFirst, type SecurityItem } from './triage.ts';
import { isLocal, scanWeb } from './web.ts';
import { reconcile } from './reconcile.ts';
import { loadVerdicts, saidByAPerson, verdictFor } from '../learn/verdicts.ts';
import { readZapReport, zapAvailable, zapInstructions } from './zap.ts';

export interface SecureCommand {
  root: string;
  out?: string;
  /** Only the secret scan, for a fast check before a commit. */
  secretsOnly?: boolean;
  /** Exit non-zero when something is a real risk, for a CI gate. */
  gate?: boolean;
  /** A running page to check: headers, cookies, and files that must not be served. */
  url?: string;
  /** Say yes to checking an address that is not this machine's. */
  authorised?: boolean;
  /** A report from an OWASP ZAP baseline scan, whose findings are triaged like the rest. */
  zapReport?: string;
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
  if (cmd.url) {
    // Checking someone else's site is their decision, not Tewip's. A local address is the person's
    // own machine; anything else has to be said out loud.
    if (!isLocal(cmd.url) && !cmd.authorised) {
      throw new Error(
        [
          `${cmd.url} is not this machine. Tewip only checks a running site when you say you are allowed to:`,
          `  tewip secure --url ${cmd.url} --i-am-authorised`,
          'It sends ordinary requests - no payloads, no fuzzing, no attempt to get past a login - but',
          'scanning a system you do not run is not Tewip\'s decision to make.',
        ].join('\n'),
      );
    }
    const scan = await scanWeb(cmd.url);
    checked.push(`${cmd.url} (${scan.requests} request(s): headers, cookies, files that must not be served)`);
    if (scan.note) notChecked.push(scan.note);
    for (const finding of scan.findings) items.push(triageWeb(finding, accepted));
  } else {
    notChecked.push('a running application (pass --url http://localhost:3000 to check one)');
  }

  if (cmd.zapReport) {
    const fromZap = readZapReport(resolve(cmd.zapReport));
    // Named as checked only once it has been read. "(0 finding(s))" above a file Tewip could not
    // open is a measurement of nothing, and a mistyped path answered exactly like a clean scan.
    if (fromZap.problem) notChecked.push(`the ZAP report you asked for: ${fromZap.problem}`);
    else checked.push(`an OWASP ZAP report (${fromZap.findings.length} finding(s))`);
    for (const finding of fromZap.findings) items.push(triageWeb(finding, accepted));
  } else if (cmd.url) {
    notChecked.push(`a full web scan. Tewip's own check is passive; for the deep one: ${zapInstructions(cmd.url, zapAvailable(root))}`);
  }

  // One check can change what another means: a secret in a file the application serves is not
  // "never left the machine", whatever git says about it.
  //
  // Assigned, not emptied and refilled. `reconcile` returns the array it was given when there is no
  // web finding to reconcile against - which is every run without `--url`, so almost every run - and
  // `items.length = 0` then emptied the very array the next line was about to copy back in. Every
  // secret found was discarded between finding it and reporting it, and the report said "0 need
  // someone now", which is what a clean repository says too.
  //
  // Found in Phase 51 by scanning Keycloak: 49 secrets located, 7 of them triaged as real risks, and
  // a report that mentioned none of them.
  let settled = reconcile([...items]);

  // A person's decision about a finding wins over Tewip's, and says whose it was.
  const corrections = loadVerdicts(root);
  settled = settled.map((item) => {
    const said = verdictFor('security', item.where, corrections) ?? verdictFor('security', item.title, corrections);
    return said ? { ...item, verdict: said.verdict as typeof item.verdict, why: `${saidByAPerson(said)} (Tewip had said ${item.verdict})` } : item;
  });
  settled.sort(worstFirst);
  const report = renderSecurity(settled, checked, notChecked, root);
  console.log(report);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
    console.log(`\nWritten to ${cmd.out}`);
  }
  return settled;
}
