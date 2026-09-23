// Phase 9: OWASP ZAP. For teams that already run a real web scanner, Tewip does not compete with
// it - it reads its report and triages the findings, the same way it does for npm audit.
//
// ZAP's baseline scan is the one teams run in CI: it crawls passively and reports what it saw. Its
// JSON report is read here; Tewip does not start a scan on a host nobody named.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { WebFinding } from './web.ts';

/** ZAP's risk names, as its report writes them. */
const RISK: Record<string, WebFinding['severity']> = { High: 'high', Medium: 'medium', Low: 'low', Informational: 'low' };

interface ZapAlert {
  alert?: string;
  name?: string;
  riskdesc?: string;
  riskcode?: string;
  confidence?: string;
  desc?: string;
  solution?: string;
  instances?: Array<{ uri?: string; evidence?: string }>;
}

/** Findings from a ZAP JSON report, in Tewip's own shape. */
export function readZapReport(path: string): WebFinding[] {
  if (!existsSync(path)) return [];
  let report: any;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const alerts: ZapAlert[] = (report.site ?? []).flatMap((site: any) => site.alerts ?? []);
  const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return alerts.map((alert) => {
    const risk = (alert.riskdesc ?? '').split(' ')[0];
    const first = (alert.instances ?? [])[0] ?? {};
    return {
      kind: `zap-${(alert.alert ?? alert.name ?? 'finding').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      what: strip(alert.alert ?? alert.name ?? 'a finding from ZAP').slice(0, 200),
      severity: RISK[risk] ?? 'low',
      evidence: `${first.uri ?? ''}${first.evidence ? ` - ${strip(first.evidence).slice(0, 120)}` : ''}`.trim() || strip(alert.desc ?? '').slice(0, 200),
      url: first.uri ?? '',
      next: strip(alert.solution ?? '').slice(0, 300) || 'see the ZAP report for the recommended fix',
    };
  });
}

/** Whether a ZAP baseline scan can be run from here at all. */
export function zapAvailable(cwd: string): 'docker' | 'script' | null {
  const has = (command: string) => spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 30_000 }).status === 0;
  if (has('zap-baseline.py --help')) return 'script';
  if (has('docker --version')) return 'docker';
  return null;
}

/**
 * How to run ZAP against this address, for the person to copy. Tewip prints it rather than running
 * it: a scan of a running system is the person's decision, and its report is read afterwards with
 * `--zap-report`.
 */
export function zapInstructions(url: string, how: 'docker' | 'script' | null): string {
  if (how === 'script') return `zap-baseline.py -t ${url} -J zap.json   # then: tewip secure --zap-report zap.json`;
  if (how === 'docker') return `docker run --rm -v "$PWD:/zap/wrk" -t ghcr.io/zaproxy/zaproxy zap-baseline.py -t ${url} -J zap.json   # then: tewip secure --zap-report zap.json`;
  return `OWASP ZAP is not installed here. With Docker: docker run --rm -v "$PWD:/zap/wrk" -t ghcr.io/zaproxy/zaproxy zap-baseline.py -t ${url} -J zap.json`;
}
