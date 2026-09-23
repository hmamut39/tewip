// Phase 9: the part scanners do not do. A scanner says "this package has a CVE" or "this looks like
// an AWS key"; a person then spends an afternoon deciding which of those matter. This decides, the
// same way the rest of Tewip decides: deterministic checks first, evidence with every verdict, and
// a plain next step.
//
// The verdicts are deliberately few:
//   real-risk      something a person should act on now, with the evidence that makes it real;
//   not-reachable  true of the repository, but not of what it runs: a dev-only dependency, or a
//                  package nothing imports;
//   noise          a shape without a secret behind it: documentation, a fixture, a placeholder;
//   accepted       a person already looked and said so.
//
// A secret is never printed, only located. An "accepted" verdict is never invented by Tewip - it
// comes from a file a person wrote.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DepFinding } from './deps.ts';
import type { SecretFinding } from './secrets.ts';
import type { WebFinding } from './web.ts';

export type Verdict = 'real-risk' | 'not-reachable' | 'noise' | 'accepted';

export interface SecurityItem {
  kind: 'secret' | 'dependency' | 'web';
  verdict: Verdict;
  /** One line: what it is and where. */
  title: string;
  /** Why this verdict, in words a person can check. */
  why: string;
  /** What to do about it. */
  next: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  where: string;
  source: string;
}

/** Findings a person has already judged, one per line: "<kind> <where> - reason". */
export function readAccepted(root: string): Set<string> {
  const file = join(root, '.tewip', 'security-accepted.txt');
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.split(' - ')[0].trim())
      .filter(Boolean),
  );
}

/** Whether git tracks this file. A secret in an ignored file never left the machine. */
export function isTracked(root: string, file: string): boolean {
  const r = spawnSync(`git ls-files --error-unmatch "${file}"`, { cwd: root, shell: true, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0;
}

const SECRET_SEVERITY: Record<string, 'critical' | 'high' | 'medium'> = {
  'aws-secret-key': 'critical',
  'aws-access-key-id': 'critical',
  'private-key': 'critical',
  'stripe-key': 'critical',
  'github-token': 'high',
  'gitlab-token': 'high',
  'npm-token': 'high',
  'openai-key': 'high',
  'anthropic-key': 'high',
  'slack-token': 'high',
  'connection-string': 'high',
  'google-api-key': 'medium',
  'jwt': 'medium',
};

export function triageSecret(finding: SecretFinding, root: string, accepted: Set<string>): SecurityItem {
  const where = `${finding.file}:${finding.line}`;
  const key = `secret ${where}`;
  const base = {
    kind: 'secret' as const,
    title: `${finding.what} in ${where}`,
    severity: SECRET_SEVERITY[finding.kind] ?? 'medium',
    where,
    source: 'tewip secret scan',
  };
  if (accepted.has(key)) return { ...base, verdict: 'accepted', why: 'a person marked this one accepted in .tewip/security-accepted.txt', next: 'nothing: it was reviewed' };
  if (finding.placeholder) {
    return { ...base, verdict: 'noise', severity: 'low', why: `${finding.placeholder}: ${finding.evidence}`, next: 'nothing: this is not a credential' };
  }
  if (finding.template) {
    // Only the file's name says this is a template; the value itself looks like a real credential.
    // Dismissing it would hide the commonest accident there is - a working key pasted into an
    // example file - so it is shown, below the ones that need acting on now.
    return {
      ...base,
      verdict: 'not-reachable',
      severity: 'medium',
      why: `${finding.evidence} - the file is a template or documentation, but the value itself does not say it is an example`,
      next: 'check whether this was ever a working credential; if it was, rotate it and replace it here with an obvious placeholder',
    };
  }
  const tracked = isTracked(root, finding.file);
  if (!tracked) {
    return {
      ...base,
      verdict: 'not-reachable',
      severity: 'low',
      why: `git does not track ${finding.file}, so this never left the machine: ${finding.evidence}`,
      next: `keep it that way: make sure ${finding.file} stays in .gitignore`,
    };
  }
  return {
    ...base,
    verdict: 'real-risk',
    why: `it is committed, and the value has the randomness of a real credential (${finding.entropy} bits per character): ${finding.evidence}`,
    next: `revoke it at the issuer first, then remove it from the file and from the history. Changing the file alone is not enough: the old value stays in every clone.`,
  };
}

/** Does anything in this project actually import the package? */
export function isImported(root: string, pkg: string, sources: string[]): boolean {
  const name = pkg.replace(/^npm:/, '');
  const patterns = [`from '${name}'`, `from "${name}"`, `require('${name}')`, `require("${name}")`, `import ${name}`, `import '${name}'`, `from ${name} import`];
  for (const file of sources) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (patterns.some((p) => text.includes(p))) return true;
  }
  return false;
}

const DEP_SEVERITY: Record<string, 'critical' | 'high' | 'medium' | 'low'> = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low' };

export function triageDependency(finding: DepFinding, root: string, sources: string[], accepted: Set<string>): SecurityItem {
  const where = `${finding.package}@${finding.version}`;
  const base = {
    kind: 'dependency' as const,
    title: `${finding.title} (${where})`,
    severity: DEP_SEVERITY[finding.severity.toLowerCase()] ?? 'medium',
    where,
    source: finding.source,
  };
  const upgrade = finding.fixedIn ? `upgrade ${finding.package} to ${finding.fixedIn}` : `no fixed version is published yet: watch ${finding.id || 'the advisory'} and consider replacing the package`;
  if (accepted.has(`dependency ${finding.package}`) || accepted.has(`dependency ${where}`)) {
    return { ...base, verdict: 'accepted', why: 'a person marked this one accepted in .tewip/security-accepted.txt', next: 'nothing: it was reviewed' };
  }
  if (finding.dev) {
    return {
      ...base,
      verdict: 'not-reachable',
      severity: base.severity === 'critical' ? 'medium' : 'low',
      why: 'it is a development dependency, so it is not in what users run',
      next: `${upgrade} when convenient; it does not block a release`,
    };
  }
  if (sources.length > 0 && !isImported(root, finding.package, sources)) {
    return {
      ...base,
      verdict: 'not-reachable',
      severity: base.severity === 'critical' ? 'medium' : 'low',
      why: `nothing in this project imports ${finding.package}: it is pulled in by another package, so the vulnerable code may never run here`,
      next: `${upgrade}, or check which dependency requires it (npm why ${finding.package}) before spending time on it`,
    };
  }
  return { ...base, verdict: 'real-risk', why: `this project imports ${finding.package} directly, and the advisory applies to the installed version`, next: upgrade };
}

/**
 * A finding about a running page. There is no "not reachable" here: the check was made against the
 * running system, so what it saw is what a visitor sees. A person can still accept one, and a page
 * that is only ever served inside a network is judged by severity, not by pretending it is safe.
 */
export function triageWeb(finding: WebFinding, accepted: Set<string>): SecurityItem {
  const where = `${finding.url} (${finding.kind})`;
  const base = { kind: 'web' as const, title: finding.what, severity: finding.severity, where, source: finding.kind.startsWith('zap-') ? 'OWASP ZAP' : 'tewip baseline web check' };
  if (accepted.has(`web ${finding.url} ${finding.kind}`) || accepted.has(`web ${finding.kind}`)) {
    return { ...base, verdict: 'accepted', why: 'a person marked this one accepted in .tewip/security-accepted.txt', next: 'nothing: it was reviewed' };
  }
  // Everything here was observed in a real response, so it is real; only how much it matters varies.
  const verdict: Verdict = finding.severity === 'low' ? 'not-reachable' : 'real-risk';
  return {
    ...base,
    verdict,
    why: verdict === 'real-risk' ? finding.evidence : `${finding.evidence} - worth fixing, but on its own it is not a way in`,
    next: finding.next,
  };
}

const ORDER: Record<Verdict, number> = { 'real-risk': 0, 'not-reachable': 1, noise: 2, accepted: 3 };
const SEV: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const worstFirst = (a: SecurityItem, b: SecurityItem): number => ORDER[a.verdict] - ORDER[b.verdict] || SEV[a.severity] - SEV[b.severity];
