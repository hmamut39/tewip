// OWASP ASI03, measured: an agent acting with its caller's credential.
//
// The Model Context Protocol authorization spec (2026-07-28) says a server "MUST NOT pass through
// the token it received from the MCP client", and gives the confused deputy as the reason: the
// service on the other end sees a credential belonging to a person and cannot tell a model chose
// the request. That is a normative rule rather than an opinion, which is what makes this check
// measurable in the same way ASI01, ASI06 and ASI07 are.
//
// Each case below is a passthrough written the way the library it belongs to documents the pieces:
// the MCP TypeScript SDK's `extra.authInfo.token`, an Express or Hono inbound header, FastAPI's
// bearer dependency. The decoys are the shapes a *correct* implementation has, and they matter more
// than the cases: a server that verifies the caller's token and then calls upstream with its own
// credential from the environment is doing exactly what the spec asks, and a check that reports it
// is worse than no check at all. The first draft of this one did precisely that.
//
// Run: node eval/identity-recall.ts
import { identityFlows } from '../engine/agent/identity-flow.ts';

const NL = String.fromCharCode(10);

interface Case {
  name: string;
  file: string;
  code: string;
  /** Whether a passthrough should be reported. */
  passthrough: boolean;
  why: string;
}

const CASES: Case[] = [
  {
    name: 'MCP SDK: the tool forwards authInfo.token',
    file: 'src/server/tools.ts',
    passthrough: true,
    why: 'the SDK hands a tool the caller’s verified token as `extra.authInfo.token`; this sends it upstream',
    code: [
      'server.registerTool("listIssues", schema, async (args, extra) => {',
      '  const token = extra.authInfo.token;',
      '  const res = await fetch("https://api.github.com/issues", {',
      '    headers: { Authorization: `Bearer ${token}` },',
      '  });',
      '  return { content: [{ type: "text", text: await res.text() }] };',
      '});',
    ].join(NL),
  },
  {
    name: 'MCP SDK: forwarded without a variable',
    file: 'src/server/direct.ts',
    passthrough: true,
    why: 'the same thing written straight into the call',
    code: [
      'server.registerTool("whoami", schema, async (args, extra) => {',
      '  return fetch("https://api.example.com/me", {',
      '    headers: { Authorization: extra.authInfo.token },',
      '  });',
      '});',
    ].join(NL),
  },
  {
    name: 'Express: the inbound Authorization header goes upstream',
    file: 'src/agent/proxy.ts',
    passthrough: true,
    why: 'the header the request arrived with is the caller’s credential',
    code: [
      'app.post("/agent/act", async (req, res) => {',
      '  const incoming = req.headers.authorization;',
      '  const upstream = await fetch(TARGET, { headers: { Authorization: incoming } });',
      '  res.json(await upstream.json());',
      '});',
    ].join(NL),
  },
  {
    name: 'Fetch-style headers.get, forwarded to a client',
    file: 'src/agent/hono.ts',
    passthrough: true,
    why: 'the same credential, read the way the fetch API reads it, handed to a client constructor',
    code: [
      'export async function handler(request: Request) {',
      '  const caller = request.headers.get("authorization");',
      '  const octokit = new Octokit({ auth: caller });',
      '  return octokit.issues.list();',
      '}',
    ].join(NL),
  },
  {
    name: 'FastAPI: the bearer dependency forwarded',
    file: 'app/agent/routes.py',
    passthrough: true,
    why: 'FastAPI puts the bearer on `.credentials`, and this agent calls out with it',
    code: [
      'async def act(creds: HTTPAuthorizationCredentials = Depends(bearer)):',
      '    token = creds.credentials',
      '    async with httpx.AsyncClient() as client:',
      '        return await client.get(TARGET, headers={"Authorization": f"Bearer {token}"})',
    ].join(NL),
  },
  // ---- the shapes a correct implementation has ----
  {
    name: 'DECOY: verifies the caller, then calls upstream with its own credential',
    file: 'src/server/correct.ts',
    passthrough: false,
    why: 'exactly what the spec asks for - the upstream token is a separate one this process owns',
    code: [
      'server.registerTool("listIssues", schema, async (args, extra) => {',
      '  const claims = await verifyToken(extra.authInfo.token);',
      '  if (!claims.aud.includes(SELF)) throw new Error("not for us");',
      '  const res = await fetch(TARGET, {',
      '    headers: { Authorization: `Bearer ${process.env.UPSTREAM_TOKEN}` },',
      '  });',
      '  return res.json();',
      '});',
    ].join(NL),
  },
  {
    name: 'DECOY: the caller is verified and never leaves',
    file: 'src/server/verify-only.ts',
    passthrough: false,
    why: 'reading the header to check it is the correct behaviour, not a finding',
    code: [
      'app.use(async (req, res, next) => {',
      '  const header = req.headers.authorization;',
      '  const payload = await jwt.verify(header.replace("Bearer ", ""), KEY);',
      '  req.user = payload.sub;',
      '  next();',
      '});',
    ].join(NL),
  },
  {
    name: 'DECOY: the server forwards its own environment credential',
    file: 'src/agent/own.ts',
    passthrough: false,
    why: 'a credential this process owns is the separate token the spec names',
    code: [
      'export async function callUpstream(body: unknown) {',
      '  const token = process.env.SERVICE_TOKEN;',
      '  return fetch(TARGET, { headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });',
      '}',
    ].join(NL),
  },
  {
    name: 'DECOY: an ordinary API client with its own key',
    file: 'src/agent/client.ts',
    passthrough: false,
    why: 'every program that talks to an API has a token variable; most of them own it',
    code: [
      'const token = config.apiToken;',
      'export const client = new Client({ auth: token, baseUrl: BASE });',
    ].join(NL),
  },
  {
    // Netflix's dispatch, found by running this over 66,307 files of the corpus.
    name: 'DECOY: the header is logged in a message that names it',
    file: 'src/dispatch/plugins/dispatch_core/plugin.py',
    passthrough: false,
    why: 'a credential in a log is a real defect and is not this one; the first version reported it because the message says "Authorization:"',
    code: [
      'def get_current_user(self, request: Request, **kwargs):',
      '    authorization: str = request.headers.get("Authorization")',
      '    scheme, param = get_authorization_scheme_param(authorization)',
      '    if not authorization or scheme.lower() != "bearer":',
      '        log.exception(',
      '            f"Malformed authorization header. Scheme: {scheme} Param: {param} Authorization: {authorization}"',
      '        )',
    ].join(NL),
  },
  {
    // Discourse, from the same run. A description of a request that arrived, not one being made.
    name: 'DECOY: an inbound webhook described for the engine that handles it',
    file: 'plugins/discourse-workflows/app/controllers/webhooks_controller.rb',
    passthrough: false,
    why: 'the hash describes a request that came in - raw_body, remote_ip, raw_authorization - and nothing leaves the process',
    code: [
      '      {',
      '        http_method: request.method,',
      '        raw_body: request.raw_post,',
      '        remote_ip: request.remote_ip,',
      '        raw_authorization: request.headers["Authorization"],',
      '        test_webhook: test_webhook,',
      '      }',
    ].join(NL),
  },
  {
    name: 'DECOY: the caller’s token is logged, which is a different defect',
    file: 'src/agent/logging.ts',
    passthrough: false,
    why: 'writing a credential to a log is real and is not ASI03 passthrough; reporting it here would blur both',
    code: [
      'app.post("/act", (req, res) => {',
      '  const incoming = req.headers.authorization;',
      '  logger.debug({ incoming }, "request arrived");',
      '  res.sendStatus(202);',
      '});',
    ].join(NL),
  },
];

export interface Measured { name: string; found: boolean }

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): { flows: Measured[]; decoys: Measured[] } {
  const ran = (c: Case) => ({ name: c.name, found: identityFlows(c.file, c.code).length > 0 });
  return {
    flows: CASES.filter((c) => c.passthrough).map(ran),
    decoys: CASES.filter((c) => !c.passthrough).map(ran),
  };
}

function report(): void {
  const lines = ['# an agent acting with its caller’s credential (OWASP ASI03), measured', ''];
  let right = 0;
  const wrong: string[] = [];
  const rows: string[] = ['| case | expected | found | |', '| --- | --- | --- | --- |'];

  for (const c of CASES) {
    const found = identityFlows(c.file, c.code);
    const ok = c.passthrough ? found.length > 0 : found.length === 0;
    if (ok) right += 1;
    else wrong.push(`${c.name}: expected ${c.passthrough ? 'a finding' : 'nothing'}, got ${found.length}`);
    rows.push(`| ${c.name} | ${c.passthrough ? 'a finding' : 'nothing'} | ${found.length} | ${ok ? 'ok' : '**wrong**'} |`);
  }

  const cases = CASES.filter((c) => c.passthrough).length;
  const decoys = CASES.length - cases;
  lines.push(
    `${right} of ${CASES.length}: ${cases} passthroughs written the way each library documents its pieces, and ${decoys} shapes a correct implementation has.`,
    '',
    ...rows,
    '',
  );
  if (wrong.length > 0) lines.push('## wrong', '', ...wrong.map((w) => `- ${w}`), '');
  lines.push(
    'The decoys are the point. A server that verifies the caller’s token and then calls upstream with its own credential from',
    'the environment is doing what the spec asks, and the first draft of this check reported that as a passthrough. A check that',
    'accuses a correct implementation is worse than no check, because the first thing it costs is the reader’s attention and the',
    'second is their belief in everything else the report says.',
    '',
  );
  process.stdout.write(lines.join(NL));
}

if (import.meta.main) report();
