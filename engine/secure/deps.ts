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

const NEWLINE = String.fromCharCode(10);

/**
 * A scanner's JSON, or `undefined` when it did not produce any.
 *
 * Empty output counts as no report rather than as an empty one. A scanner that printed nothing
 * cannot be told apart from a scanner that crashed before it printed, and the two possible
 * mistakes are not equally bad: calling a clean scan unreadable sends somebody to look, while
 * calling an unreadable scan clean is the false all-clear this whole report exists to avoid.
 */
function readJson(out: string): any {
  if (!out.trim()) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/**
 * Did this scanner produce a report, or only exit?
 *
 * `key` is the field its report always carries, so JSON that parses but is not a scan result - a
 * usage message, a progress object, an error body - is caught too. The exit code is deliberately
 * not consulted: pip-audit and npm audit both exit non-zero precisely when they have found
 * something, so treating that as failure would discard the findings that matter most.
 */
export function scanOutcome(
  tool: string,
  out: string,
  err: string,
  shape: { key: string; orArray?: boolean },
  read: (r: any) => DepFinding[],
): ScanOutcome {
  const report = readJson(out);
  if (report === undefined) return { findings: [], problem: `${tool} did not return a report${firstLine(out, err)}` };
  // Older pip-audit prints the dependency list unwrapped, so a bare array is a real report there
  // and nowhere else. Accepting one everywhere would let a stray array pass for an empty scan.
  const known = report?.[shape.key] !== undefined || (shape.orArray === true && Array.isArray(report));
  if (!known) return { findings: [], problem: `${tool} returned JSON that is not a scan report` };
  return { findings: read(report), problem: null };
}

/** The first line a failing tool said, for the report - whichever stream it used. */
function firstLine(out: string, err: string): string {
  const said = [err, out].map((x) => x.trim()).find(Boolean);
  return said ? `: ${said.split(NEWLINE)[0].slice(0, 120)}` : '';
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
export function npmAudit(root: string): ScanOutcome {
  if (!existsSync(join(root, 'package.json'))) return { findings: [], problem: null };
  const { out, err } = run('npm audit --json', root);
  let report: any;
  try {
    report = JSON.parse(out);
  } catch {
    return { findings: [], problem: `npm audit did not return a report${err.trim() ? `: ${err.trim().split(NEWLINE)[0].slice(0, 120)}` : ''}` };
  }
  // npm reports a refusal inside the JSON and still exits 0: no lockfile, a registry that will not
  // answer, a private registry needing credentials. None of those is "nothing found".
  // Two shapes, both exiting 0. A refusal names itself - {"error":{"code":"ENOLOCK","summary":...}}
  // - while a registry that cannot be reached leaves those fields empty and puts the reason in
  // `message`. Reading summary with ?? kept the empty string, so an unreachable registry passed for
  // a clean audit on a project with three known advisories.
  const failure = report.error || (report.message && !report.vulnerabilities);
  if (failure) {
    const reason = [report.error?.summary, report.error?.code, report.message, 'npm audit could not run'].find((x: unknown) => typeof x === 'string' && x.trim());
    const hint = report.error?.code === 'ENOLOCK' ? ' (run `npm i --package-lock-only` first)' : '';
    return { findings: [], problem: `${String(reason).slice(0, 160)}${hint}` };
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
  return { findings, problem: null };
}

/**
 * What pip-audit found, given what it printed. Separated from running it so the shapes real
 * pip-audit produces can be tested without the tool installed.
 */
export function pipFindings(report: any): DepFinding[] {
  const list = report?.dependencies ?? report;
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
}

/** `pip-audit`, when the project is Python and the tool is installed. */
export function pipAudit(root: string): ScanOutcome {
  const python = ['requirements.txt', 'pyproject.toml', 'setup.py'].some((f) => existsSync(join(root, f)));
  if (!python || !has('pip-audit', root)) return { findings: [], problem: null };
  const { out, err } = run('pip-audit -f json --progress-spinner off', root);
  return scanOutcome('pip-audit', out, err, { key: 'dependencies', orArray: true }, pipFindings);
}

/**
 * What osv-scanner found, given what it printed. Separated from running it for the same reason as
 * `pipFindings`: the parsing is what needs testing, and the tool is rarely installed.
 */
export function osvFindings(report: any): DepFinding[] {
    const findings: DepFinding[] = [];
    for (const result of report?.results ?? []) {
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
}

/** OSV-Scanner, which covers Go, Rust, Java, Ruby, PHP and more, when it is installed. */
export function osvScan(root: string): ScanOutcome {
  if (!has('osv-scanner', root)) return { findings: [], problem: null };
  const { out, err } = run(`osv-scanner --format json --recursive "${root}"`, root);
  return scanOutcome('osv-scanner', out, err, { key: 'results' }, osvFindings);
}

export interface AuditResult {
  findings: DepFinding[];
  /** Which scanners ran, and which were not installed, so a reader knows what was not checked. */
  ran: string[];
  missing: string[];
}

/**
 * What one scanner produced, and why it produced nothing when it produced nothing.
 *
 * A scanner that could not run is not a scanner that found nothing, and the difference is the whole
 * value of this report. On a project with no lockfile, `npm audit` answers
 * `{"error":{"code":"ENOLOCK"}}` and exits 0; Tewip read that as an empty result and told the reader
 * "Checked: npm audit. 0 need someone now" about a project declaring a vulnerable package. A clean
 * bill of health that was never earned is worse than no report at all.
 */
export interface ScanOutcome {
  findings: DepFinding[];
  problem: string | null;
}

export function auditDependencies(root: string): AuditResult {
  const ran: string[] = [];
  const missing: string[] = [];
  const findings: DepFinding[] = [];
  // `ran` used to be pushed before the scanner was called, so a pip-audit that was installed and
  // failed left "Checked: pip-audit" standing above zero findings. Measured on a project pinning
  // requests==2.19.1 and flask==0.12.2 - both long known vulnerable - with a pip-audit that exited
  // without JSON: the report read "Checked: secrets in the working tree, pip-audit. 0 need someone
  // now." A scanner is named as having run only once it has returned something readable.
  const record = (tool: string, outcome: ScanOutcome) => {
    if (outcome.problem) missing.push(`${tool} could not run: ${outcome.problem}`);
    else ran.push(tool);
    findings.push(...outcome.findings);
  };

  if (existsSync(join(root, 'package.json'))) {
    record('npm audit', npmAudit(root));
  }
  const python = ['requirements.txt', 'pyproject.toml', 'setup.py'].some((f) => existsSync(join(root, f)));
  if (python) {
    if (has('pip-audit', root)) record('pip-audit', pipAudit(root));
    else missing.push('pip-audit (pip install pip-audit) for the Python dependencies');
  }
  if (has('osv-scanner', root)) record('osv-scanner', osvScan(root));
  else if (!existsSync(join(root, 'package.json')) && !python) {
    missing.push('osv-scanner (https://osv.dev) for this project\'s ecosystem');
  }
  return { findings: findings.sort(bySeverity), ran, missing };
}
