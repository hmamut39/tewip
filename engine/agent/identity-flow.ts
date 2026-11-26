// OWASP ASI03, Identity and Privilege Abuse: the agent acting with its caller's credential.
//
// The other agent flow checks ask what reaches the model (`prompt-flow.ts`, ASI01) and what reaches
// a store it reads back (`memory-flow.ts`, ASI06). This asks a different question: whose authority
// does the agent act with when it calls something else?
//
// ASI03 is "the agent operates with more permissions than its task requires, or borrows a user
// session or shared credentials, amplifying blast radius". The borrowing has a normative rule
// behind it, which is why this check exists and the rest of ASI03 does not yet. The Model Context
// Protocol authorization spec (2026-07-28) states it plainly:
//
//   "The MCP server MUST NOT pass through the token it received from the MCP client."
//
// The reason the spec gives is the confused deputy: a downstream service sees a valid token and
// cannot tell that the request was decided by a model rather than by the person the token belongs
// to. Every scope that person has becomes a scope the agent has, for whatever the model chooses to
// do next - which is the blast radius ASI03 is about.
//
// Two things this does not do, stated here rather than discovered from a report:
//
//   - It does not read scope or audience claims. Whether a token's `aud` names this server is a
//     runtime fact about a signed value, not something in the source.
//   - It says nothing about the agent having too many permissions of its own. That is the other
//     half of ASI03 and needs a different kind of evidence - an IAM policy, an OAuth client
//     registration - which is `infra`'s material and not this file's.
//
// One named variable, one function body, no call graph: the same discipline as the two checks
// beside it, for the same reason. A list of maybes gets switched off, and then somebody has written
// "we check for privilege abuse" on a form.
import { sameBody } from '../taint/flow.ts';

const NL = String.fromCharCode(10);

export interface IdentityFlow {
  file: string;
  line: number;
  /** The credential that came in with the request, quoted from the code. */
  source: string;
  /** Whose credential it is, in words a reader can check. */
  origin: string;
  /** How it got there: written into the call, or through a named variable. */
  through: string;
  /** What it was handed to, quoted from the code. */
  onward: string;
  evidence: string;
}

/**
 * The credential this process was given by whoever called it.
 *
 * Deliberately narrow. Each of these is the caller's own token in a documented place: the MCP
 * TypeScript SDK hands a verified token to a tool as `extra.authInfo.token`, and an inbound
 * `Authorization` header is the same thing one layer down. A bare `token` variable is not here and
 * must not be: every program that talks to an API has one, and most of them own it.
 */
const SOURCES: Array<{ re: string; origin: string }> = [
  {
    // The MCP SDK's own shape. `authInfo` is what the SDK calls the caller's verified token, so the
    // name is evidence rather than a guess.
    re: String.raw`\b(?:extra|context|ctx|req|request)?\s*\.?\s*auth(?:Info|_info)\s*\.\s*token\b`,
    origin: 'the token the MCP client sent, which the SDK hands to a tool as authInfo',
  },
  {
    re: String.raw`\b(?:req|request|ctx|context|event)\s*\.\s*auth\s*\.\s*token\b`,
    origin: 'the token this request arrived with',
  },
  {
    // An inbound Authorization header, in the four shapes the common servers use.
    re: String.raw`\b(?:req|request|ctx|context|event)\s*\.\s*headers\s*\.\s*(?:get\s*\(\s*["'][Aa]uthorization["']\s*\)|[Aa]uthorization\b)`,
    origin: 'the Authorization header this request arrived with',
  },
  {
    re: String.raw`\b(?:req|request|ctx|context|event)\s*\.\s*headers\s*\[\s*["'](?:[Aa]uthorization|AUTHORIZATION)["']\s*\]`,
    origin: 'the Authorization header this request arrived with',
  },
  {
    // FastAPI's documented bearer dependency: the credential lands on `.credentials`.
    re: String.raw`\b\w*(?:credentials|creds)\w*\s*\.\s*credentials\b`,
    origin: 'the bearer credential FastAPI took off this request',
  },
];

/**
 * Handing it to something else.
 *
 * An outbound call that carries an Authorization header, or a client constructed with an `auth`.
 * The header name is required: a value going into a body, a log or a database is a different
 * defect, and reporting those here would make the finding mean nothing.
 */
const ONWARD = String.raw`(?:["']?[Aa]uthorization["']?\s*[:=]|headers\s*\.\s*set\s*\(\s*["'][Aa]uthorization["']|\bauth\s*[:=]|\baccess_token\s*=|\bbearer_token\s*=)`;

/**
 * Checking it, which is the opposite of passing it on and must never be reported.
 *
 * A server that reads the caller's token to verify it is doing exactly what the spec asks. The
 * first draft of this check had no such list, and on a correct MCP server - one that verifies the
 * token and then calls upstream with its own credential from the environment - it reported the
 * verification as a passthrough. That is the shape a correct implementation has, so a check that
 * accuses it is worse than no check.
 */
const VERIFIES = new RegExp(
  String.raw`\b(?:jwt\s*\.\s*verify|jwtVerify|verify_token|verifyToken|verify_jwt|verifyJwt|introspect\w*|decode_token|decodeToken|validate_token|validateToken|getTokenPayload|requireAuth|authenticate)\s*\(`,
);

/**
 * A verifier taking the credential as an argument, which is the same thing one line up.
 *
 * `VERIFIES` names the calls exactly; this catches the ones named by their job. Discourse hands the
 * inbound header to `Livekit::WebhookVerifier.verify!(authorization: request.headers["Authorization"],
 * body: body)` - the method says what it does, the header is an argument to it, and the call sits on
 * the line above. Measured across 66,307 files of the corpus, two of the three findings this check
 * produced were that shape, and both were correct implementations being accused.
 *
 * Looking back rather than at the line, because the argument and the call it belongs to are rarely
 * on the same line once the argument list has more than one entry.
 */
const VERIFIER_NEARBY = /\b\w*(?:[Vv]erif|[Vv]alidat|[Aa]uthenticat|[Ii]ntrospect|[Dd]ecod)\w*\s*[!.(]/;

/**
 * A call that leaves this process, which is what makes a passthrough a passthrough.
 *
 * ASI03 is the agent *acting* with somebody else's authority. An Authorization value that never
 * leaves is not that, whatever it is named, and requiring the outbound call is a better rule than
 * the list of exceptions that would otherwise keep growing. Two real findings made the case, both
 * from the corpus and both wrong:
 *
 *   - Netflix's dispatch logs `f"Malformed authorization header. Scheme: {scheme} ... Authorization:
 *     {authorization}"`. A credential in a log is a real defect and it is not this one; reporting it
 *     here would blur both.
 *   - Discourse builds a hash describing an inbound webhook - `http_method`, `raw_body`,
 *     `remote_ip`, `raw_authorization` - and hands it to its workflow engine. That is a description
 *     of a request that arrived, not a request being made.
 *
 * Both stop matching once an outbound call is required, and neither needed a rule of its own.
 */
const OUTBOUND = new RegExp(
  String.raw`\b(?:fetch|axios|httpx|requests|urllib|got|ky|superagent|HTTParty|RestClient)\b` +
    String.raw`|\bNet\s*::\s*HTTP\b` +
    String.raw`|\bnew\s+\w*(?:Client|Api|API|Octokit|SDK)\w*\s*\(` +
    String.raw`|\b\w*(?:client|session|http|api)\w*\s*\.\s*(?:get|post|put|patch|delete|request|send)\s*\(`,
  'i',
);


const lineOf = (text: string, at: number): number => text.slice(0, at).split(NL).length;
const quote = (text: string, at: number): string => {
  const from = text.lastIndexOf(NL, at) + 1;
  const to = text.indexOf(NL, at);
  return text.slice(from, to === -1 ? text.length : to).trim().slice(0, 160);
};

/** One finding, worded the same whether the forward was written inline or through a variable. */
function describe(file: string, text: string, at: number, source: string, origin: string, named: string | null, onward: string): IdentityFlow {
  const line = lineOf(text, at);
  const through = named ? `the variable \`${named}\`` : 'written straight into the call';
  return {
    file,
    line,
    source,
    origin,
    through,
    onward,
    evidence:
      `${origin} is sent onward at ${file}:${line}, ${through}. ` +
      'The Model Context Protocol authorization spec says a server "MUST NOT pass through the token it received from the MCP ' +
      'client", because the service on the other end sees a credential belonging to a person and cannot tell that a model chose ' +
      'the request. Every scope that person has is a scope this agent has. The separate credential the spec asks for is one this ' +
      'process owns - from its environment or its own authorization server - not the one it was handed.',
  };
}

/** The caller's credential, handed onward to something else, in one function body. */
export function identityFlows(file: string, text: string): IdentityFlow[] {
  const found: IdentityFlow[] = [];
  for (const { re, origin } of SOURCES) {
    for (const hit of text.matchAll(new RegExp(re, 'g'))) {
      const at = hit.index ?? 0;
      const source = hit[0];

      // The variable it was put in, if it was put in one. Both spellings: `const token = ...` and
      // Python's bare `token = ...`, which the first draft did not have - so every FastAPI case went
      // unreported, because its sink carries the variable rather than the expression.
      const before = text.slice(Math.max(0, at - 120), at);
      const named =
        /(?:const|let|var)\s+(\w+)\s*(?::\s*[\w[\]|]+\s*)?=\s*[^;\n=]*$/.exec(before)?.[1] ??
        /(?:^|\n)\s*(\w+)\s*(?::\s*[\w[\]|]+\s*)?=\s*[^;\n=]*$/.exec(before)?.[1] ??
        null;

      // Past the end of the source, not past its start. `req.headers.authorization` contains the
      // word `authorization`, so a sink pattern that allowed the source's own text matched the
      // declaration line itself, and a function that only *logged* the caller's token was reported
      // as forwarding it - on the strength of the line that read it.
      const after = at + source.length;
      // A passthrough is also written with the header before the value, on one line:
      // `headers: { Authorization: extra.authInfo.token }`. That sink sits *before* the source, so
      // the source's own line has to be a candidate as well.
      const ownLine = quote(text, at);
      const onOwnLine = new RegExp(ONWARD).exec(ownLine);
      // Not the declaration that reads it. Netflix's dispatch writes
      // `authorization: str = request.headers.get("Authorization")`, a Python typed assignment, and
      // then checks the scheme is bearer. The name on the left is `authorization`, so a sink
      // pattern looking for `authorization:` matched the line that read the value, and the
      // correct implementation was reported as forwarding what it was about to verify.
      const isDeclaration = onOwnLine ? (onOwnLine.index ?? 0) < ownLine.indexOf('=') : false;
      const aroundOwn = text.slice(Math.max(0, at - 300), at + 200);
      if (
        onOwnLine &&
        !isDeclaration &&
        ownLine.includes(source) &&
        !VERIFIES.test(ownLine) &&
        !VERIFIER_NEARBY.test(text.slice(Math.max(0, at - 200), at)) &&
        OUTBOUND.test(aroundOwn)
      ) {
        found.push(describe(file, text, at, source, origin, null, ownLine));
        continue;
      }
      for (const carry of text.matchAll(new RegExp(ONWARD, 'g'))) {
        const to = carry.index ?? 0;
        if (to < after) continue;
        if (!sameBody(text, at, to)) continue;
        // The sink has to actually carry this value: the variable it was named, or the expression
        // itself. Without this, any function that reads a token and separately sets an
        // Authorization header on its own credential was reported.
        const sinkLine = quote(text, to);
        const carriesIt = named ? new RegExp(String.raw`\b${named}\b`).test(sinkLine) : sinkLine.includes(source);
        if (!carriesIt) continue;
        // The two things that make this correct rather than wrong, above.
        const body = text.slice(at, to + 200);
        if (VERIFIES.test(body) && !named) continue;
        if (named && new RegExp(String.raw`\b(?:jwt\s*\.\s*verify|verify\w*|introspect\w*|decode\w*|validate\w*)\s*\(\s*${named}\b`).test(text)) continue;
        // Nothing left this process, so nothing acted with anybody's authority: see `OUTBOUND`.
        if (!OUTBOUND.test(text.slice(Math.max(0, to - 300), to + 200))) continue;
        // A verifier named by its job, taking this as an argument a line or two above.
        if (VERIFIER_NEARBY.test(text.slice(Math.max(0, to - 200), to))) continue;

        found.push(describe(file, text, to, source, origin, named, sinkLine));
        break;
      }
    }
  }
  // One finding per line: the same forward matched by two source patterns is one problem.
  const seen = new Set<string>();
  return found.filter((f) => {
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
