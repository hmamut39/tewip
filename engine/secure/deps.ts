// Phase 9: known-vulnerable dependencies. Tewip runs no scanner of its own here - the ecosystems
// already have good ones, and their databases are updated daily by people whose job that is. It
// runs whichever is available (npm, pip, or OSV for everything else), reads their output, and then
// does the part they do not: say which findings actually matter in this project.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface DepFinding {
  /** The package, as its ecosystem names it. */
  package: string;
  version: string;
  /** 'critical' | 'high' | 'moderate' | 'low', as the scanner said it. */
  severity: string;
  /** CVE or advisory id. */
  id: string;
  title: string;
  /** The version that fixes it, when the scanner knows one. */
  fixedIn: string;
  /** Which tool said so, for the report. */
  source: string;
  /** True when the ecosystem says this is a development dependency. */
  dev: boolean;
  /**
   * The scanner knows of a fix, but not which version: `npm audit` answers `fixAvailable: true`
   * when `npm audit fix` can resolve it without naming a version. Reading only the object form made
   * Tewip tell a team "no fixed version is published yet, consider replacing the package" about
   * three packages npm could have fixed in one command.
   */
  fixExists: boolean;
  /** True when the project declares this package itself, rather than inheriting it. */
  direct: boolean;
}

const run = (command: string, cwd: string, timeoutMs = 5 * 60_000) => {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 40 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
};

const has = (command: string, cwd: string): boolean => run(`${command} --version`, cwd, 30_000).code === 0;

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'medium', 'low', 'info'];
export const bySeverity = (a: DepFinding, b: DepFinding): number =>
  SEVERITY_ORDER.indexOf(a.severity.toLowerCase()) - SEVERITY_ORDER.indexOf(b.severity.toLowerCase());

/** `npm audit --json`, which needs no install and no account: every Node project already has it. */
export function npmAudit(root: string): DepFinding[] {
  if (!existsSync(join(root, 'package.json'))) return [];
  const { out } = run('npm audit --json', root);
  let report: any;
  try {
    report = JSON.parse(out);
  } catch {
    return [];
  }
  const findings: DepFinding[] = [];
  for (const [name, entry] of Object.entries<any>(report.vulnerabilities ?? {})) {
    const via = (entry.via ?? []).find((v: any) => typeof v === 'object');
    findings.push({
      package: name,
      version: String(entry.range ?? ''),
      severity: String(entry.severity ?? 'unknown'),
      id: String(via?.url?.split('/').pop() ?? via?.source ?? ''),
      title: String(via?.title ?? `${name} has a known vulnerability`),
      fixedIn: entry.fixAvailable && typeof entry.fixAvailable === 'object' ? String(entry.fixAvailable.version ?? '') : '',
      fixExists: entry.fixAvailable === true || (entry.fixAvailable && typeof entry.fixAvailable === 'object'),
      direct: entry.isDirect === true,
      source: 'npm audit',
      dev: Boolean(entry.isDirect === false ? false : entry.dev ?? false) || Boolean(entry.effects?.length === 0 && entry.dev),
    });
  }
  return findings;
}

/** `pip-audit`, when the project is Python and the tool is installed. */
export function pipAudit(root: string): DepFinding[] {
  const python = ['requirements.txt', 'pyproject.toml', 'setup.py'].some((f) => existsSync(join(root, f)));
  if (!python || !has('pip-audit', root)) return [];
  const { out } = run('pip-audit -f json --progress-spinner off', root);
  try {
    const report = JSON.parse(out);
    const list = report.dependencies ?? report;
    return (Array.isArray(list) ? list : []).flatMap((dep: any) =>
      (dep.vulns ?? []).map((v: any) => ({
        package: String(dep.name ?? ''),
        version: String(dep.version ?? ''),
        severity: String(v.severity ?? 'unknown').toLowerCase(),
        id: String(v.id ?? ''),
        title: String(v.description ?? '').split('\n')[0].slice(0, 200),
        fixedIn: (v.fix_versions ?? []).join(', '),
        source: 'pip-audit',
        dev: false,
      })),
    );
  } catch {
    return [];
  }
}

/** OSV-Scanner, which covers Go, Rust, Java, Ruby, PHP and more, when it is installed. */
export function osvScan(root: string): DepFinding[] {
  if (!has('osv-scanner', root)) return [];
  const { out } = run(`osv-scanner --format json --recursive "${root}"`, root);
  try {
    const report = JSON.parse(out);
    const findings: DepFinding[] = [];
    for (const result of report.results ?? []) {
      for (const pkg of result.packages ?? []) {
        for (const v of pkg.vulnerabilities ?? []) {
          findings.push({
            package: String(pkg.package?.name ?? ''),
            version: String(pkg.package?.version ?? ''),
            severity: String(v.database_specific?.severity ?? v.severity?.[0]?.type ?? 'unknown').toLowerCase(),
            id: String(v.id ?? ''),
            title: String(v.summary ?? '').slice(0, 200),
            fixedIn: '',
            // osv-scanner's output says neither which version fixes it nor whether the project
            // declares the package, so neither is claimed.
            fixExists: false,
            direct: false,
            source: 'osv-scanner',
            dev: false,
          });
        }
      }
    }
    return findings;
  } catch {
    return [];
  }
}

export interface AuditResult {
  findings: DepFinding[];
  /** Which scanners ran, and which were not installed, so a reader knows what was not checked. */
  ran: string[];
  missing: string[];
}

export function auditDependencies(root: string): AuditResult {
  const ran: string[] = [];
  const missing: string[] = [];
  const findings: DepFinding[] = [];

  if (existsSync(join(root, 'package.json'))) {
    ran.push('npm audit');
    findings.push(...npmAudit(root));
  }
  const python = ['requirements.txt', 'pyproject.toml', 'setup.py'].some((f) => existsSync(join(root, f)));
  if (python) {
    if (has('pip-audit', root)) {
      ran.push('pip-audit');
      findings.push(...pipAudit(root));
    } else {
      missing.push('pip-audit (pip install pip-audit) for the Python dependencies');
    }
  }
  if (has('osv-scanner', root)) {
    ran.push('osv-scanner');
    findings.push(...osvScan(root));
  } else if (!existsSync(join(root, 'package.json')) && !python) {
    missing.push('osv-scanner (https://osv.dev) for this project\'s ecosystem');
  }
  return { findings: findings.sort(bySeverity), ran, missing };
}
