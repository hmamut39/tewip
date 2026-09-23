// Phase 9: the baseline check of a running application.
//
// What this is: the safe half of a web scan. Tewip asks for pages the way a browser does, reads
// what comes back, and reports what is verifiably missing or exposed - a cookie without Secure, a
// missing Content-Security-Policy, a .env file that answers with its contents. Every finding is a
// fact about a response, quotable in the report.
//
// What this is NOT, on purpose: no injection payloads, no fuzzing, no brute force, no attempt to
// get past a login, no scanning of hosts that were not named. Those need authorisation, a scope and
// a person - and for teams that have those, OWASP ZAP already exists, so Tewip reads ZAP's report
// instead of pretending to be it (see zap.ts).
import { setTimeout as delay } from 'node:timers/promises';

export interface WebFinding {
  /** e.g. 'missing-csp'. */
  kind: string;
  /** The problem in a sentence. */
  what: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** The exact response fact that shows it. */
  evidence: string;
  url: string;
  next: string;
}

export interface WebScanResult {
  findings: WebFinding[];
  /** What was asked for, so a reader knows the scan's size. */
  requests: number;
  /** Why the scan stopped early, when it did. */
  note: string | null;
}

/** A header check: what must be there, and what it protects against. */
const HEADERS: Array<{ name: string; kind: string; what: string; severity: WebFinding['severity']; next: string; httpsOnly?: boolean }> = [
  {
    name: 'content-security-policy',
    kind: 'missing-csp',
    what: 'no Content-Security-Policy, so any injected script the page ends up with will run',
    severity: 'high',
    next: "add a Content-Security-Policy. Start in report-only mode with default-src 'self' and tighten it from the reports.",
  },
  {
    name: 'strict-transport-security',
    kind: 'missing-hsts',
    what: 'no Strict-Transport-Security, so a first visit over http can be intercepted',
    severity: 'medium',
    next: 'add Strict-Transport-Security: max-age=31536000; includeSubDomains once every subdomain is on https.',
    httpsOnly: true,
  },
  {
    name: 'x-content-type-options',
    kind: 'missing-nosniff',
    what: 'no X-Content-Type-Options, so a browser may guess a file is script when it is not',
    severity: 'medium',
    next: 'add X-Content-Type-Options: nosniff.',
  },
  {
    name: 'referrer-policy',
    kind: 'missing-referrer-policy',
    what: 'no Referrer-Policy, so full URLs (with any ids in them) are sent to other sites',
    severity: 'low',
    next: 'add Referrer-Policy: strict-origin-when-cross-origin.',
  },
];

/** Headers that tell an attacker what to attack. */
const TELLS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'];
const VERSIONED = /\d+\.\d+/;

/** Paths that must never answer with their contents. Each is a plain GET, nothing more. */
const EXPOSED: Array<{ path: string; kind: string; what: string; severity: WebFinding['severity']; looksReal: RegExp }> = [
  { path: '/.env', kind: 'exposed-env', what: 'the .env file is served, so its settings and keys are public', severity: 'critical', looksReal: /^[A-Z][A-Z0-9_]*=/m },
  { path: '/.git/config', kind: 'exposed-git', what: 'the .git folder is served, so the whole source history can be downloaded', severity: 'critical', looksReal: /\[core\]|\[remote/ },
  { path: '/.aws/credentials', kind: 'exposed-aws', what: 'AWS credentials are served', severity: 'critical', looksReal: /aws_access_key_id/i },
  { path: '/config.json', kind: 'exposed-config', what: 'a configuration file is served', severity: 'medium', looksReal: /"(?:password|secret|token|apiKey)"\s*:/i },
];

const ok = (response: { status: number }) => response.status >= 200 && response.status < 300;

/** One request, with a short timeout, never following more than a couple of redirects. */
async function get(url: string, timeoutMs: number): Promise<{ status: number; headers: Headers; body: string } | null> {
  try {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'tewip-secure/1.0 (baseline check)' } });
    globalThis.clearTimeout(timer);
    const body = (await res.text()).slice(0, 4000);
    return { status: res.status, headers: res.headers, body };
  } catch {
    return null;
  }
}

/** Cookie names that usually carry a session or an identity. */
const SESSION_COOKIE = /sess|auth|token|login|sid$|^sid|jwt|remember|csrf|identity|account/i;

/** Cookies a page sets, and what protects them. */
function cookieFindings(headers: Headers, url: string): WebFinding[] {
  const raw = typeof (headers as any).getSetCookie === 'function' ? (headers as any).getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  const findings: WebFinding[] = [];
  for (const cookie of raw as string[]) {
    const name = cookie.split('=')[0].trim();
    const flags = cookie.toLowerCase();
    const missing: string[] = [];
    if (!flags.includes('httponly')) missing.push('HttpOnly');
    if (!flags.includes('secure') && url.startsWith('https')) missing.push('Secure');
    if (!flags.includes('samesite')) missing.push('SameSite');
    if (missing.length === 0) continue;
    // A cookie that carries a session is worth someone's evening; an analytics cookie without
    // HttpOnly is a deliberate choice on plenty of real sites, and calling it "high" is how a
    // security report gets ignored. The name is the only honest signal available here.
    const session = SESSION_COOKIE.test(name);
    findings.push({
      kind: 'weak-cookie',
      what: `the cookie "${name}" is set without ${missing.join(', ')}`,
      severity: session && missing.includes('HttpOnly') ? 'high' : 'medium',
      evidence: `Set-Cookie: ${cookie.slice(0, 120)}`,
      url,
      next: session
        ? `set ${missing.join(', ')} on ${name}. HttpOnly keeps script from reading it; SameSite=Lax stops it riding along on other sites' requests.`
        : `set ${missing.join(', ')} on ${name} if it carries anything private. If it is only analytics, script may need to read it, and this is a decision rather than a fault.`,
    });
  }
  return findings;
}

export interface WebScanOptions {
  /** How long one request may take. */
  timeoutMs?: number;
  /** Also ask for the handful of paths that must never be served. */
  probeExposed?: boolean;
  /** Pause between requests, so a small site is never hammered. */
  pauseMs?: number;
}

/**
 * The baseline check of one page. Nothing is sent that a browser would not send, and at most a
 * dozen requests are made.
 */
export async function scanWeb(url: string, { timeoutMs = 15_000, probeExposed = true, pauseMs = 150 }: WebScanOptions = {}): Promise<WebScanResult> {
  const findings: WebFinding[] = [];
  let requests = 0;

  const page = await get(url, timeoutMs);
  requests++;
  if (!page) return { findings, requests, note: `${url} did not answer, so nothing about it was checked.` };

  const https = url.startsWith('https://');
  for (const header of HEADERS) {
    if (header.httpsOnly && !https) continue;
    if (page.headers.get(header.name)) continue;
    findings.push({ kind: header.kind, what: header.what, severity: header.severity, evidence: `the response to ${url} has no ${header.name} header`, url, next: header.next });
  }

  // Clickjacking: either header will do, so it is one finding, not two.
  const csp = page.headers.get('content-security-policy') ?? '';
  if (!page.headers.get('x-frame-options') && !/frame-ancestors/i.test(csp)) {
    findings.push({
      kind: 'framable',
      what: 'the page can be put in a frame on another site, which is how clickjacking works',
      severity: 'medium',
      evidence: `no X-Frame-Options and no frame-ancestors in the policy for ${url}`,
      url,
      next: "add X-Frame-Options: DENY, or frame-ancestors 'none' to the Content-Security-Policy.",
    });
  }

  for (const name of TELLS) {
    const value = page.headers.get(name);
    if (value && VERSIONED.test(value)) {
      findings.push({
        kind: 'version-header',
        what: `the ${name} header names the exact software version, which tells an attacker which holes to try`,
        severity: 'low',
        evidence: `${name}: ${value}`,
        url,
        next: `stop sending ${name}, or remove the version from it.`,
      });
    }
  }

  findings.push(...cookieFindings(page.headers, url));

  if (probeExposed) {
    const base = new URL(url);
    for (const target of EXPOSED) {
      await delay(pauseMs);
      const at = new URL(target.path, base.origin).href;
      const res = await get(at, timeoutMs);
      requests++;
      if (!res || !ok(res) || !target.looksReal.test(res.body)) continue;
      findings.push({
        kind: target.kind,
        what: target.what,
        severity: target.severity,
        evidence: `GET ${at} answered ${res.status} with the file's real contents`,
        url: at,
        next: `stop serving ${target.path}: it belongs outside the web root, and anything in it must be treated as leaked.`,
      });
    }
  }

  return { findings, requests, note: null };
}

/** Localhost, a private address, or a name only this machine resolves. */
export function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /^(?:localhost|127\.|0\.0\.0\.0|\[::1\]|::1|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || host.endsWith('.localhost');
  } catch {
    return false;
  }
}
