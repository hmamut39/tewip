// Phase 9, the running application. These tests run a real HTTP server and check what Tewip says
// about it - what it finds, what it leaves alone, and what it refuses to do at all. The refusals
// matter most: a tool that scans whatever address it is handed is a tool nobody may install.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { isLocal, scanWeb } from '../secure/web.ts';
import { triageWeb } from '../secure/triage.ts';
import { readZapReport } from '../secure/zap.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface App {
  url: string;
  close: () => void;
}

function serve(headers: Record<string, string>, files: Record<string, string> = {}): Promise<App> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const body = files[path];
    if (path !== '/' && body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end(body ?? '<!doctype html><title>app</title>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

const kinds = (findings: Array<{ kind: string }>) => findings.map((f) => f.kind).sort();

describe('checking a running page', () => {
  it('names what a rushed app is missing, with the response as evidence', async () => {
    const app = await serve({ server: 'nginx/1.18.0', 'set-cookie': 'session=abc; Path=/' });
    try {
      const { findings, requests } = await scanWeb(app.url, { probeExposed: false, pauseMs: 0 });
      assert.deepEqual(kinds(findings), ['framable', 'missing-csp', 'missing-nosniff', 'missing-referrer-policy', 'version-header', 'weak-cookie']);
      assert.equal(requests, 1, 'one page, one request');
      const csp = findings.find((f) => f.kind === 'missing-csp')!;
      assert.match(csp.evidence, /has no content-security-policy header/);
      assert.match(csp.next, /Content-Security-Policy/);
    } finally {
      app.close();
    }
  });

  it('says nothing about an app that is served carefully', async () => {
    const app = await serve({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      server: 'nginx',
      'set-cookie': 'session=abc; Path=/; HttpOnly; SameSite=Lax',
    });
    try {
      const { findings } = await scanWeb(app.url, { probeExposed: false, pauseMs: 0 });
      assert.deepEqual(findings, [], 'a correctly served page must produce no report at all');
    } finally {
      app.close();
    }
  });

  it('finds a file that must never be served, and only when it really is one', async () => {
    const leaking = await serve({}, { '/.env': 'DATABASE_URL=postgres://app:secret@db/app\n' });
    const pretty404 = await serve({}, { '/.env': '<!doctype html><title>Page not found</title>' });
    try {
      const leak = await scanWeb(leaking.url, { pauseMs: 0 });
      assert.ok(kinds(leak.findings).includes('exposed-env'));
      assert.equal(leak.findings.find((f) => f.kind === 'exposed-env')!.severity, 'critical');

      const none = await scanWeb(pretty404.url, { pauseMs: 0 });
      assert.ok(!kinds(none.findings).includes('exposed-env'), 'a page that merely answers 200 is not a leaked .env');
    } finally {
      leaking.close();
      pretty404.close();
    }
  });

  it('weighs a session cookie above an analytics one', async () => {
    const app = await serve({ 'set-cookie': 'analytics_id=123; Path=/' });
    try {
      const { findings } = await scanWeb(app.url, { probeExposed: false, pauseMs: 0 });
      const cookie = findings.find((f) => f.kind === 'weak-cookie')!;
      assert.equal(cookie.severity, 'medium', 'an analytics cookie without HttpOnly is a choice, not a hole');
      assert.match(cookie.next, /if it carries anything private/);
    } finally {
      app.close();
    }
  });

  it('says so plainly when the address does not answer', async () => {
    const result = await scanWeb('http://127.0.0.1:1/', { timeoutMs: 2000, probeExposed: false });
    assert.deepEqual(result.findings, []);
    assert.match(result.note ?? '', /did not answer/);
  });
});

describe('what it refuses', () => {
  it('knows this machine from somebody else\'s', () => {
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:8080/x', 'http://192.168.1.10/', 'http://10.0.0.5/', 'http://app.local/']) {
      assert.equal(isLocal(local), true, local);
    }
    for (const remote of ['https://example.com', 'https://shop.customer.co.uk/checkout', 'http://8.8.8.8/']) {
      assert.equal(isLocal(remote), false, remote);
    }
  });
});

describe('reading a real scanner\'s report', () => {
  it('turns an OWASP ZAP report into the same kind of finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tewip-zap-'));
    const file = join(dir, 'zap.json');
    writeFileSync(
      file,
      JSON.stringify({
        site: [
          {
            alerts: [
              { alert: 'Content Security Policy (CSP) Header Not Set', riskdesc: 'Medium (High)', desc: '<p>CSP is missing.</p>', solution: '<p>Set the header.</p>', instances: [{ uri: 'http://localhost:3000/', evidence: '' }] },
              { alert: 'Cookie No HttpOnly Flag', riskdesc: 'Low (Medium)', desc: '<p>A cookie.</p>', solution: '<p>Add HttpOnly.</p>', instances: [{ uri: 'http://localhost:3000/', evidence: 'Set-Cookie: session' }] },
            ],
          },
        ],
      }),
      'utf8',
    );
    const findings = readZapReport(file);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].severity, 'medium');
    assert.match(findings[0].what, /Content Security Policy/);
    assert.ok(!findings[0].next.includes('<p>'), 'the report is read as words, not as html');

    const item = triageWeb(findings[0], new Set());
    assert.equal(item.source, 'OWASP ZAP');
    assert.equal(item.verdict, 'real-risk');
    assert.equal(triageWeb(findings[1], new Set()).verdict, 'not-reachable', 'a low finding is worth fixing, not worth an evening');
  });
});

// Phase 71: `isLocal` is a consent control, not a convenience. `secure --url` refuses a non-local
// address without `--i-am-authorised`, so anything this accepts is scanned with no questions asked.
// It was a prefix match, and five hostnames walked past it.
describe('whether consent is needed before touching a running site', () => {
  it('accepts this machine, by name and by every private range', () => {
    for (const url of [
      'http://localhost:3000',
      'http://LOCALHOST:3000',
      'http://127.0.0.1:3000',
      'http://127.1.2.3',
      'http://0.0.0.0:8080',
      'http://[::1]:3000',
      'http://10.1.2.3',
      'http://192.168.0.5',
      'http://172.16.0.1',
      'http://172.31.255.254',
      'http://shop.local',
      'http://api.localhost:4000',
    ]) {
      assert.equal(isLocal(url), true, `${url} is this machine or its network`);
    }
  });

  it('refuses a host that merely begins with something local-looking', () => {
    // Every one of these was accepted as "this machine", so Tewip would have scanned a host
    // somebody else controls without ever asking. `localhost.<anything>` is one of the oldest
    // allowlist bypasses there is, and a careless paste reaches it as easily as a malicious one.
    for (const url of [
      'http://localhost.evil.example',
      'http://localhostile.example',
      'http://10.evil.example',
      'http://127.0.0.1.evil.example',
      'http://172.16.evil.example',
      'http://192.168.0.5.evil.example',
    ]) {
      assert.equal(isLocal(url), false, `${url} is not this machine and consent must be asked for`);
    }
  });

  it('refuses the ranges that are not private, including the metadata endpoint', () => {
    // 169.254.169.254 is where a cloud instance keeps its credentials. Asking before touching it
    // is exactly what this function is for.
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://192.0.2.1', 'https://example.com', 'http://172.32.0.1', 'http://11.0.0.1', 'http://192.169.0.1']) {
      assert.equal(isLocal(url), false, `${url} needs --i-am-authorised`);
    }
  });

  it('refuses something that is not a URL at all rather than guessing', () => {
    for (const bad of ['not a url', '', 'localhost:3000', '://x']) assert.equal(isLocal(bad), false);
  });
});
