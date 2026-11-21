// An agent interface somebody else can reach, and whether anything checks who they are.
//
// OWASP ASI07, Insecure Inter-Agent Communication. The other two agent flow checks ask what happens
// to text once it is inside the process. This asks the question before that one: is there a door,
// and is it on the street.
//
// It is a conjunction, like the lethal trifecta next door, and for the same reason. An agent
// interface on its own is the normal way to build a multi-agent system. A bind to `0.0.0.0` on its
// own is the normal way to run anything in a container. Together, in one file, they are a port that
// speaks the agent protocol to whoever reaches it - and the agent protocols were written on the
// assumption that the thing on the other end is one of yours.
//
// **This is a fact, not an accusation,** and the report says so in those words. Tewip reads source.
// It cannot see the ingress, the service mesh, the security group or the sidecar that may well be
// doing the authentication, and `0.0.0.0` inside a container with a gateway in front of it is
// correct. What it can do is say where the door is and whether anything *in this file* checks a
// caller, which is the half somebody can act on without taking Tewip's word for the other half.
import { blank } from './source-text.ts';

const NL = String.fromCharCode(10);

export interface AgentDoor {
  file: string;
  line: number;
  /** Which agent protocol this file serves, quoted from the code. */
  door: string;
  /** The bind that puts it beyond this machine, quoted from the code. */
  binding: string;
  /** An authentication check in the same file, or null when there is none to find. */
  auth: string | null;
  evidence: string;
}

/**
 * Serving an agent protocol, in the shapes the protocols themselves publish.
 *
 * A2A's agent card lives at a well-known path and its v1.0 method is `SendMessage`; the MCP SDK's
 * two HTTP transports are classes with names nothing else uses. Each is a server-side shape:
 * `fetch`ing somebody else's agent card is being a client, which is a different question.
 */
const DOOR = /\/\.well-known\/agent(?:-card)?\.json|\bSSEServerTransport\b|\bStreamableHTTPServerTransport\b|\bAgentCard\b|\bSendMessage\b/g;

/**
 * A bind that is not this machine.
 *
 * `0.0.0.0` and `::` are every interface. A loopback bind is deliberately absent: it is the safe
 * answer, it is what Tewip's own A2A server does on purpose, and reporting it would turn the one
 * shape that gets this right into a finding.
 */
const EXPOSED = /(["'`])(?:0\.0\.0\.0|::)\1|\bhost\s*[:=]\s*["'`]?(?:0\.0\.0\.0|::)\b|--host[= ]["']?(?:0\.0\.0\.0|::)/g;

/**
 * Something in this file that looks at who is calling.
 *
 * Reported as context and never as a verdict. Its presence does not mean the door is protected -
 * the check may be on another route - and its absence does not mean it is open, because the
 * gateway in front is not in this file. It is here because "no caller is checked anywhere in the
 * file that opens the door" is worth a reader's attention, and because saying only half of what
 * was looked at is how a report misleads without stating anything untrue.
 */
const AUTH = /\bAuthorization\b|\bBearer\b|\bapi[_-]?key\b|\bverify(?:Token|Jwt|Signature)\b|\brequireAuth\b|\bauthenticate\b|\bOAuth\b|\bjwt\.verify\b/i;

const lineOf = (text: string, index: number): number => text.slice(0, index).split(NL).length;

/**
 * Reading somebody else's agent card rather than serving one.
 *
 * The well-known path is identical in both directions - `app.get("/.well-known/agent-card.json")`
 * serves it and `fetch(peer + "/.well-known/agent-card.json")` reads it - so the path alone cannot
 * tell a server from a client. The decoy in eval/door-recall.ts fetched a peer's card beside an
 * ordinary bind and was reported as a door on the street, which is a whole repository accused of
 * exposing an interface it only ever calls.
 *
 * So the statement around the match is read: an outbound call in it means this end is the client.
 */
const OUTBOUND = /\b(?:fetch|axios|requests|httpx|urlopen|got|ky)\b/;

function isClient(code: string, at: number): boolean {
  const start = Math.max(code.lastIndexOf(NL, at), code.lastIndexOf(';', at)) + 1;
  const stop = code.indexOf(NL, at);
  return OUTBOUND.test(code.slice(start, stop === -1 ? code.length : stop));
}

export function agentDoors(file: string, text: string): AgentDoor[] {
  // Strings are kept, not blanked: `"0.0.0.0"` and the well-known path are string literals, and
  // this is the one check here whose evidence lives inside the quotes rather than outside them.
  // The comment half is still dropped, because a bind written in a comment binds nothing.
  const code = blank(text, /\.py$/i.test(file)).code;

  const doors = [...code.matchAll(DOOR)].filter((d) => !isClient(code, d.index ?? 0));
  if (doors.length === 0) return [];
  const binds = [...code.matchAll(EXPOSED)];
  if (binds.length === 0) return [];

  const auth = AUTH.exec(code);
  const found: AgentDoor[] = [];
  // One finding per file, not per match. A server names its transport in three places and binds
  // once, and reporting that as three problems is how a reader learns to skim a section.
  const door = doors[0];
  const bind = binds[0];
  const at = bind.index ?? 0;
  found.push({
    file,
    line: lineOf(text, at),
    door: door[0].replace(/\s+/g, ' ').slice(0, 60),
    binding: bind[0].replace(/\s+/g, ' ').slice(0, 40),
    auth: auth ? auth[0] : null,
    evidence: (text.split(NL)[lineOf(text, at) - 1] ?? '').trim().slice(0, 160),
  });
  return found;
}
