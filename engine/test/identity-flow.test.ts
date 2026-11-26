// OWASP ASI03, Identity and Privilege Abuse: the agent acting with its caller's credential.
//
// The Model Context Protocol authorization spec (2026-07-28) states that a server "MUST NOT pass
// through the token it received from the MCP client", and gives the confused deputy as the reason:
// the service on the other end sees a credential belonging to a person and cannot tell a model
// chose the request.
//
// `eval/identity-recall.ts` measures this against each library's documented shapes, and
// `confidence-is-current.test.ts` re-derives that figure. These are the behaviours underneath it,
// and most of them are here because the first version got them wrong on real code. Phase 224.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { identityFlows } from '../agent/identity-flow.ts';

const NL = String.fromCharCode(10);

describe('an agent acting with its caller’s credential', () => {
  it('reports the MCP SDK shape, through a variable and written inline', () => {
    const viaVariable = identityFlows(
      'src/tools.ts',
      [
        'server.registerTool("x", s, async (args, extra) => {',
        '  const token = extra.authInfo.token;',
        '  return fetch(TARGET, { headers: { Authorization: `Bearer ${token}` } });',
        '});',
      ].join(NL),
    );
    assert.equal(viaVariable.length, 1);
    assert.match(viaVariable[0].through, /the variable `token`/);
    assert.match(viaVariable[0].evidence, /MUST NOT pass through the token/, 'the rule is quoted, not paraphrased');

    // Written straight into the call, where the header sits *before* the value on the line.
    const inline = identityFlows(
      'src/direct.ts',
      ['server.registerTool("x", s, async (args, extra) => {', '  return fetch(TARGET, { headers: { Authorization: extra.authInfo.token } });', '});'].join(NL),
    );
    assert.equal(inline.length, 1, 'the sink can precede the source on one line');
    assert.match(inline[0].through, /straight into the call/);
  });

  it('says nothing when the caller is verified and the agent uses its own credential', () => {
    // The shape a correct implementation has. A check that accuses this is worse than no check.
    const found = identityFlows(
      'src/correct.ts',
      [
        'server.registerTool("x", s, async (args, extra) => {',
        '  const claims = await verifyToken(extra.authInfo.token);',
        '  if (!claims.aud.includes(SELF)) throw new Error("not for us");',
        '  return fetch(TARGET, { headers: { Authorization: `Bearer ${process.env.UPSTREAM_TOKEN}` } });',
        '});',
      ].join(NL),
    );
    assert.deepEqual(found, []);
  });

  it('does not report a credential that never leaves the process', () => {
    // ASI03 is the agent *acting* with somebody else's authority. Netflix's dispatch logs
    // `f"Malformed authorization header. ... Authorization: {authorization}"`, which is a real
    // defect and a different one; reporting it here would blur both.
    const logged = identityFlows(
      'plugin.py',
      [
        'def get_current_user(self, request: Request):',
        '    authorization: str = request.headers.get("Authorization")',
        '    scheme, param = get_authorization_scheme_param(authorization)',
        '    if not authorization or scheme.lower() != "bearer":',
        '        log.exception(f"Malformed header. Scheme: {scheme} Authorization: {authorization}")',
      ].join(NL),
    );
    assert.deepEqual(logged, [], 'a log is not an outbound call');
  });

  it('does not report the declaration that reads the header', () => {
    // `authorization: str = request.headers.get("Authorization")` is a Python typed assignment.
    // The name on the left is `authorization`, so a sink pattern looking for `authorization:`
    // matched the very line that read the value.
    const found = identityFlows(
      'plugin.py',
      ['def f(request):', '    authorization: str = request.headers.get("Authorization")', '    return requests.get(TARGET)'].join(NL),
    );
    assert.deepEqual(found, [], 'the line that reads it is not the line that forwards it');
  });

  it('does not report a header handed to a verifier named by its job', () => {
    // Discourse: `Livekit::WebhookVerifier.verify!(authorization: request.headers["Authorization"],
    // body: body)`. The method says what it does and the call is on the line above.
    const found = identityFlows(
      'livekit_webhooks_controller.rb',
      [
        '    def create',
        '      body = request.body.read',
        '      Livekit::WebhookVerifier.verify!(',
        '        authorization: request.headers["Authorization"],',
        '        body: body,',
        '      )',
        '    end',
      ].join(NL),
    );
    assert.deepEqual(found, [], 'verifying is the opposite of forwarding');
  });

  it('does not report a description of a request that arrived', () => {
    // Discourse again: a hash of inbound webhook fields handed to its workflow engine. Nothing
    // leaves the process, so nothing acted with anybody's authority.
    const found = identityFlows(
      'webhooks_controller.rb',
      [
        '      {',
        '        http_method: request.method,',
        '        raw_body: request.raw_post,',
        '        raw_authorization: request.headers["Authorization"],',
        '      }',
      ].join(NL),
    );
    assert.deepEqual(found, [], 'a request described is not a request made');
  });

  it('reads Python, where an assignment has no keyword in front of it', () => {
    // Every FastAPI case went unreported while the variable pattern required const, let or var.
    const found = identityFlows(
      'routes.py',
      [
        'async def act(creds: HTTPAuthorizationCredentials = Depends(bearer)):',
        '    token = creds.credentials',
        '    async with httpx.AsyncClient() as client:',
        '        return await client.get(TARGET, headers={"Authorization": f"Bearer {token}"})',
      ].join(NL),
    );
    assert.equal(found.length, 1);
    assert.match(found[0].origin, /bearer credential FastAPI took off this request/);
  });

  it('stays silent on a verifier even when something else does leave the process', () => {
    // The outbound rule alone is not enough here: a webhook relay verifies the inbound signature
    // and then forwards the *body*. Without reading the verifier on the line above, the header
    // handed to `verify!` is reported as a passthrough because a real outbound call is in scope.
    const found = identityFlows(
      'relay.rb',
      [
        'def create',
        '  body = request.body.read',
        '  Livekit::WebhookVerifier.verify!(',
        '    authorization: request.headers["Authorization"],',
        '    body: body,',
        '  )',
        '  HTTParty.post(FORWARD_URL, body: body)',
        'end',
      ].join(NL),
    );
    assert.deepEqual(found, [], 'the header went to the verifier; the body went to the relay');
  });

  it('stays silent on a verifier reached through a variable, not only inline', () => {
    // The same relay written in JavaScript, where the credential goes through a named variable and
    // the verifier call is a line above the argument. The Ruby case above takes the inline path;
    // this one takes the other, and both need reading the verifier to stay quiet.
    const found = identityFlows(
      'relay.ts',
      [
        'async function relay(req) {',
        '  const caller = req.headers.authorization;',
        '  await verifyWebhook({',
        '    authorization: caller,',
        '  });',
        '  await fetch(FORWARD, { body: req.body });',
        '}',
      ].join(NL),
    );
    assert.deepEqual(found, [], 'the credential was checked, and what was forwarded was the body');
  });

  it('reports one finding per place, not one per credential on the line', () => {
    const found = identityFlows(
      'src/both.ts',
      ['async function f(req, extra) {', '  return fetch(T, { headers: { Authorization: extra.authInfo.token, "X-Auth": req.auth.token } });', '}'].join(NL),
    );
    assert.equal(found.length, 1, 'one line forwarding two credentials is one place to fix');
  });
});
