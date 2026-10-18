// Phase 9: secrets left in a repository. This is the one security check Tewip does itself, because
// it needs no tool installed and no network: a credential either matches a shape its issuer
// publishes, or it does not.
//
// Two rules keep it honest. A finding must quote where it is, never what it is: the value is
// redacted everywhere, including in the report and in anything posted to CI. And a shape alone is
// not a risk - "AKIAIOSFODNN7EXAMPLE" is in Amazon's own documentation - so a match that looks like
// a placeholder, or that has too little randomness to be a real key, is reported as noise rather
// than as a leak.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface SecretFinding {
  /** e.g. 'aws-access-key-id'. */
  kind: string;
  /** What it is, for a person: "an AWS access key id". */
  what: string;
  file: string;
  line: number;
  /** The line with the value blanked out. Tewip never prints a credential. */
  evidence: string;
  /** How much randomness the value has: a real key has a lot, a placeholder little. */
  entropy: number;
  /** Set when the value looks like documentation, a fixture or an obvious placeholder. */
  placeholder: string | null;
  /** Set when the credential is real text but its destination is only this machine. */
  localOnly?: string | null;
  /** Set when the file is a template or documentation, whatever the value looks like. */
  template: boolean;
}

/** Shapes their own issuers publish. Each one is a credential, not a guess about one. */
const PATTERNS: Array<{ kind: string; what: string; re: RegExp; minEntropy?: number }> = [
  { kind: 'aws-access-key-id', what: 'an AWS access key id', re: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16})\b/g, minEntropy: 2.5 },
  { kind: 'aws-secret-key', what: 'an AWS secret access key', re: /\baws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})\b/gi },
  { kind: 'github-token', what: 'a GitHub token', re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { kind: 'gitlab-token', what: 'a GitLab personal access token', re: /\b(glpat-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g },
  { kind: 'slack-token', what: 'a Slack token', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { kind: 'slack-webhook', what: 'a Slack incoming webhook', re: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{20,})/g },
  // Stripe writes both "live" and "prod" on real keys; a "test" key is not a credential, and is
  // left alone on purpose. The prod form was missed until a labelled sample showed it.
  { kind: 'stripe-key', what: 'a live Stripe key', re: /\b((?:sk|rk)_(?:live|prod)_[A-Za-z0-9]{20,})(?![A-Za-z0-9])/g },
  // A key may end in "-", where a word boundary never matches: a real Google key was missed that
  // way. And "sk-ant-..." is Anthropic's, not OpenAI's, so the looser shape must exclude it or one
  // credential gets reported twice under two names.
  { kind: 'openai-key', what: 'an OpenAI API key', re: /\b(sk-(?:proj-|svcacct-|admin-)?(?!ant-)[A-Za-z0-9_-]{32,})(?![A-Za-z0-9_-])/g },
  { kind: 'anthropic-key', what: 'an Anthropic API key', re: /\b(sk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{32,})(?![A-Za-z0-9_-])/g },
  { kind: 'google-api-key', what: 'a Google API key', re: /\b(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g },
  { kind: 'npm-token', what: 'an npm token', re: /\b(npm_[A-Za-z0-9]{36})\b/g },
  { kind: 'pypi-token', what: 'a PyPI token', re: /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})\b/g },
  { kind: 'sendgrid-key', what: 'a SendGrid key', re: /\b(SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g },
  { kind: 'twilio-key', what: 'a Twilio key', re: /\b(SK[a-f0-9]{32})\b/g },
  { kind: 'digitalocean-token', what: 'a DigitalOcean token', re: /\b(dop_v1_[a-f0-9]{64})\b/g },
  // The header *and* some key after it. Matching the header alone made a constant that merely
  // names the format into a leaked key: Keycloak's PemUtils.java declares
  // `BEGIN_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----"` so that it can recognise one, and Tewip
  // told Red Hat they had committed two private keys. There is no key on those lines at all.
  { kind: 'private-key', what: 'a private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\r\n\s]+([A-Za-z0-9+/=]{20,})/g, minEntropy: 0 },
  { kind: 'connection-string', what: 'a database URL with a password in it', re: /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s'"]+:([^@\s'"]{6,})@[^\s'"]+)/g },
  { kind: 'jwt', what: 'a signed token (JWT)', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/g },
  // A password in a web address leaks the same way a database URL does, and is easier to miss.
  { kind: 'url-credentials', what: 'a password inside a URL', re: /\b(https?:\/\/[^:/\s'"]+:([^@\s'"]{4,})@[^\s'"]+)/g, minEntropy: 2 },
];

/** How random a value is, in bits per character. A real key is above 3; "xxxxxxxx" is 0. */
export function entropyOf(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PLACEHOLDER_WORDS = /example|placeholder|dummy|sample|changeme|your[-_ ]?(?:key|token|secret|api)|xxxx|redacted|fake|notreal|test[-_]?key|<[^>]+>|\$\{|\{\{/i;
/** Files whose whole purpose is to show the shape of a secret, not to hold one. */
// An OpenAPI schema is documentation of an API, and every credential in one is an example by
// construction - nocodb's swagger.json nests them three deep under "Example 1", too far for a
// one-line lookback to see. The file says what it is, which is a steadier signal than the shape
// of the JSON around the value.
const DOC_FILE = /(?:^|[\\/])(?:\.env\.example|\.env\.sample|\.env\.template|[^\\/]*\.(?:md|rst|txt|adoc)|[^\\/]*example[^\\/]*|[^\\/]*sample[^\\/]*|(?:swagger|openapi)[\w.-]*\.(?:json|ya?ml))$/i;

/**
 * Why this match is probably not a live credential, or null when nothing says so.
 *
 * The file's name is deliberately not enough on its own any more. A realistic AWS key placed in
 * `src/config-sample.js` was dismissed as noise - "nothing: this is not a credential" - while the
 * identical key in `src/settings.js` was reported as critical. A filename is the weakest evidence
 * there is, and a key pasted into an example file by accident is one of the commonest ways
 * credentials leak. That case is now shown as a template finding instead of being dismissed.
 */
/**
 * A URL-shaped credential whose destination cannot be a real system, or whose user and password
 * are the same word.
 *
 * A credential matters because it is a way in to something. `postgres://saleor:saleor@localhost`
 * is a way in to the machine it is already running on, and `user:password@example.com` points at
 * a domain reserved by RFC 2606 precisely so that it cannot be anybody's system.
 *
 * Measured on Saleor at its pinned commit: six findings were reported as needing someone now, at
 * high severity, each telling the team to "revoke it at the issuer first". Three were the Django
 * local-development default in settings.py, one of them on a commented-out line, and the evidence
 * offered was that the value "has the randomness of a real credential" - about the word `saleor`.
 *
 * Nothing is dropped. The finding becomes a placeholder finding, shown as noise with its reason
 * attached. Suppressing a real secret is far worse than reporting a false one, so the two tests
 * are narrow: a destination that provably reaches nobody, and a password identical to its own
 * username, which nobody chooses for a credential that guards anything.
 */
/** Domains that exist so they cannot be anybody's system (RFC 2606, RFC 6761). */
const RESERVED = /^(?:[\w-]+\.)*example\.(?:com|org|net)$|\.(?:invalid|test|localhost|local)$/i;
/** Addresses that only ever mean the machine the code is running on. */
const THIS_MACHINE = /^(?:localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/i;
const CREDENTIALLED_URL = /[a-z][a-z0-9+.-]*:\/\/([^:/\s'\"]+):([^@\s'\"]+)@([^/\s'\"?#]+)/gi;

/**
 * A credential whose destination is the machine it runs on.
 *
 * This is deliberately not treated as a placeholder. A hardcoded password in settings.py is a real
 * string that a person should see - an earlier phase decided exactly that, about this exact case -
 * and calling it noise would hide it. What was wrong was only the urgency: Saleor's Django default
 * was reported as needing someone now, at high severity, told to "revoke it at the issuer first".
 * There is no issuer. It belongs in "real, but not reachable", which is the bucket for something
 * true of the repository and not of what it runs.
 */
export function credentialGoesNowhere(value: string, line: string): string | null {
  for (const [, , password, hostport] of [...value.matchAll(CREDENTIALLED_URL), ...[...line.matchAll(CREDENTIALLED_URL)].filter((m) => m[2] === value)]) {
    if (password !== value && !value.includes(password)) continue;
    const host = hostport.replace(/:\d+$/, '');
    if (THIS_MACHINE.test(host)) return `the URL points at ${host}, so it reaches only the machine it runs on`;
  }
  return null;
}

export function urlCredentialIsHarmless(value: string, line: string): string | null {
  // The URL rules capture the whole URL as the value, not the password inside it - which is also
  // why these pass the entropy gate at all, and why the report offered "the randomness of a real
  // credential (3.82 bits per character)" as evidence about a string that is mostly the word
  // `postgres` and a hostname. So the value is read as a URL first, and only then looked for inside
  // the line, which is how the patterns that do capture a bare password arrive here.
  const inValue = [...value.matchAll(CREDENTIALLED_URL)];
  const inLine = [...line.matchAll(CREDENTIALLED_URL)].filter((m) => m[2] === value);
  for (const [, user, password, hostport] of [...inValue, ...inLine]) {
    const host = hostport.replace(/:\d+$/, '');
    if (RESERVED.test(host)) return `the URL points at ${host}, a domain reserved so that it cannot be anybody's system`;
    if (user.toLowerCase() === password.toLowerCase()) return 'the user and the password are the same word, which is a stand-in rather than a credential';
  }
  return null;
}

export function looksPlanted(value: string, line: string, file: string, before = '', whole = value): string | null {
  if (PLACEHOLDER_WORDS.test(value)) return 'the value itself says it is an example';
  // Only the words *around* the credential are commentary about it. A hostname or a database name
  // inside the URL is part of the credential: a real password at db.acme-prod.example-corp.io was
  // dismissed because "example" was in the line, and it was in the line because it was in the host.
  const around = line.split(whole).join(' ');
  if (PLACEHOLDER_WORDS.test(around)) return 'the line around it says it is an example';
  // JSON and YAML put the key on its own line when the value is long, and an OpenAPI schema is all
  // long values. nocodb declares `"example":` and then the token underneath it, so reading only the
  // token's line found nothing and the sample JWTs in its API documentation were reported as real.
  if (/"?(?:example|sample|placeholder|default|demo)"?\s*:\s*$/i.test(before.trim())) return 'the key above it says it is an example';
  if (/(.)\1{5,}/.test(value)) return 'the value repeats one character, so it is a stand-in';
  const harmless = urlCredentialIsHarmless(value, line);
  if (harmless) return harmless;
  return null;
}

/** True when only the file's name suggests a template, whatever the value itself looks like. */
export const inATemplate = (file: string): boolean => DOC_FILE.test(file);

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.tewip', '.next', '.cache']);
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|eot|mp4|mp3|wav|class|jar|pyc|lock)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Every text file in a project, skipping what no repository owns. */
export function sourceFiles(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const path = join(dir, entry);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIR.has(entry)) walk(path);
        continue;
      }
      if (BINARY.test(entry) || info.size > MAX_FILE_BYTES) continue;
      out.push(path);
    }
  };
  walk(root);
  return out;
}

/** The value, blanked: first two characters, then dots. Tewip never prints a credential. */
export function redact(line: string, value: string): string {
  const shown = value.slice(0, 2);
  const hidden = `${shown}${'.'.repeat(Math.min(12, Math.max(4, value.length - 2)))}`;
  return line.replace(value, hidden).trim().slice(0, 200);
}

export function scanSecrets(root: string, files = sourceFiles(root)): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary after all
    const lines = text.split('\n');
    for (const { kind, what, re, minEntropy } of PATTERNS) {
      for (const match of text.matchAll(re)) {
        const value = match[1];
        // Where a pattern captures the credential separately, that is what gets judged. The two
        // URL rules capture the whole URL first and the password second, and judging the URL meant
        // a hostname or a database name decided whether a password was real: a genuine credential
        // at db.acme-prod.example-corp.io was dismissed because its host contains "example", and
        // any connection string to a database called sample or demo would go the same way.
        // Suppressing a real secret is the worst thing this scanner can do, and it was one word in
        // an unrelated part of the string away. The whole match is still what gets redacted, so
        // nothing of the URL is printed either way.
        const secret = match[2] ?? value;
        const entropy = entropyOf(secret);
        if (entropy < (minEntropy ?? 3)) continue;
        const index = match.index ?? 0;
        const line = text.slice(0, index).split('\n').length;
        const rel = relative(root, file).split(sep).join('/');
        // One credential, one finding: a value can match a loose shape and a tighter one, and the
        // same key reported under two names reads as two leaks.
        const key = `${rel}:${line}:${value}`;
        if (seen.has(key) || seen.has(`${rel}:${line}`)) continue;
        seen.add(key);
        seen.add(`${rel}:${line}`);
        findings.push({
          kind,
          what,
          file: rel,
          line,
          evidence: redact(lines[line - 1] ?? '', value),
          entropy: Number(entropy.toFixed(2)),
          placeholder: looksPlanted(secret, lines[line - 1] ?? '', rel, lines[line - 2] ?? '', value),
          localOnly: credentialGoesNowhere(value, lines[line - 1] ?? ''),
          template: inATemplate(rel),
        });
      }
    }
  }
  return findings;
}
