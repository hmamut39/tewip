// What a Terraform file opens to the internet, read from the file and nothing else.
//
// `infra` read Dockerfiles and stopped, which meant it stopped one layer below where companies
// actually get hurt. A container running as root is a problem for whoever is already inside the
// container. A bucket with a public ACL, or a security group holding 0.0.0.0/0 open on port 22, is
// a problem for everybody on the internet, and it is written down in a file in the repository.
//
// The same bargain as the rest of this directory: no cloud account, no network, no state file, no
// plan. Only what is certain from the text, each finding quoting the line it came from. That rules
// out most of the category - a value that arrives through a variable, a module from the registry,
// anything decided at apply time - and the report says so rather than letting silence read as
// approval.
import type { IacFinding } from './dockerfile.ts';

const NL = String.fromCharCode(10);

/** The world, in the two spellings Terraform writes it. */
const EVERYWHERE = /["'](?:0\.0\.0\.0\/0|::\/0)["']/;

/** Ports that should never be open to everybody, with what they are. */
const SENSITIVE: Record<string, string> = {
  '22': 'SSH',
  '3389': 'RDP',
  '3306': 'MySQL',
  '5432': 'PostgreSQL',
  '27017': 'MongoDB',
  '6379': 'Redis',
  '9200': 'Elasticsearch',
  '1433': 'SQL Server',
  '5984': 'CouchDB',
  '11211': 'memcached',
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split(NL).length;
const shown = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);

/**
 * The body of the block that starts at `from`, to its matching brace.
 *
 * A rule has to see the whole block: an ingress rule is only dangerous because of the port *and*
 * the cidr together, and they are different lines.
 */
function blockAt(text: string, from: number): string {
  const open = text.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < text.length && i < open + 20_000; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1, Math.min(text.length, open + 20_000));
}

/** Comments blanked, lengths kept, so a commented-out rule is not reported as a live one. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split(NL)
    .map((line) => {
      const hash = line.indexOf('#');
      const slash = line.indexOf('//');
      const at = hash === -1 ? slash : slash === -1 ? hash : Math.min(hash, slash);
      if (at === -1) return line;
      const quotes = (line.slice(0, at).match(/"/g) ?? []).length;
      return quotes % 2 === 0 ? line.slice(0, at) + ' '.repeat(line.length - at) : line;
    })
    .join(NL);
}

export function readTerraform(file: string, raw: string): IacFinding[] {
  const text = withoutComments(raw);
  const out: IacFinding[] = [];
  const add = (line: number, rule: string, what: string, because: string, evidence: string, risk: IacFinding['risk'] = 'high') =>
    out.push({ file, line, rule, what, because, evidence: shown(evidence), risk });

  // A security group rule that lets the whole internet in.
  for (const m of text.matchAll(/\bingress\s*(?:\{|=\s*\[?\s*\{)/g)) {
    const at = m.index ?? 0;
    const body = blockAt(text, at);
    if (!EVERYWHERE.test(body)) continue;
    const from = /from_port\s*=\s*(\d+)/.exec(body)?.[1];
    const to = /to_port\s*=\s*(\d+)/.exec(body)?.[1];
    const named = from && SENSITIVE[from] ? SENSITIVE[from] : undefined;
    // Port 0 to 65535, or no port written at all, is everything.
    const everyPort = from === '0' && (to === '0' || to === '65535');
    add(
      lineOf(text, at),
      'open-to-the-internet',
      named
        ? `${named} (port ${from}) is open to every address on the internet`
        : everyPort
          ? 'every port is open to every address on the internet'
          : `port ${from ?? '?'}${to && to !== from ? ` to ${to}` : ''} is open to every address on the internet`,
      named
        ? `${named} is a login. Open to 0.0.0.0/0 it is reachable by every scanner on the internet, continuously`
        : 'anything listening behind this is reachable by anybody, not only by the parts of your system that need it',
      body,
      named || everyPort ? 'high' : 'medium',
    );
  }

  // A bucket anybody can read, in the two places Terraform spells it.
  for (const m of text.matchAll(/\bacl\s*=\s*["'](public-read(?:-write)?)["']/g)) {
    add(
      lineOf(text, m.index ?? 0),
      'storage-public',
      `storage with a "${m[1]}" ACL`,
      m[1] === 'public-read-write'
        ? 'anybody on the internet can read this and write to it, which includes deleting what is there'
        : 'anybody on the internet can read every object in it, without an account and without a log entry you would notice',
      m[0],
    );
  }
  for (const m of text.matchAll(/\baws_s3_bucket_public_access_block\b/g)) {
    const body = blockAt(text, m.index ?? 0);
    const off = ['block_public_acls', 'ignore_public_acls', 'block_public_policy', 'restrict_public_buckets'].filter((k) =>
      new RegExp(`${k}\\s*=\\s*false`).test(body),
    );
    if (off.length === 0) continue;
    add(
      lineOf(text, m.index ?? 0),
      // Its own rule, not `storage-public`: the report groups by rule and prints the first
      // finding's words as the heading, so two different facts under one rule name puts a
      // sentence over an item it is not true of.
      'storage-guard-off',
      `the public access block is turned off: ${off.join(', ')}`,
      'this resource exists to stop a bucket being made public by accident. Switched off, the guard rail is gone and nothing else replaces it.',
      body,
    );
  }

  // A policy that can do anything to anything.
  for (const m of text.matchAll(/"Action"\s*:\s*(?:\[\s*)?["']\*["']/g)) {
    const around = text.slice(Math.max(0, (m.index ?? 0) - 600), (m.index ?? 0) + 600);
    if (!/"Resource"\s*:\s*(?:\[\s*)?["']\*["']/.test(around)) continue;
    add(
      lineOf(text, m.index ?? 0),
      'permission-unbounded',
      'a policy granting every action on every resource',
      'whoever holds this can do anything your account can do, including removing the trail that would show they did',
      around.slice(around.indexOf('"Action"'), around.indexOf('"Action"') + 200),
    );
  }

  // Storage written in the clear.
  for (const m of text.matchAll(/\b(?:encrypted|storage_encrypted|encryption_enabled)\s*=\s*false\b/g)) {
    add(
      lineOf(text, m.index ?? 0),
      'stored-unencrypted',
      'storage encryption is explicitly turned off',
      'a disk or a snapshot that leaves the building is readable as it stands. Encryption at rest is usually one line and is what the regulation asks about.',
      m[0],
      'medium',
    );
  }

  // Logging turned off, which is how an incident becomes unanswerable.
  for (const m of text.matchAll(/\b(?:enable_logging|logging_enabled)\s*=\s*false\b/g)) {
    add(
      lineOf(text, m.index ?? 0),
      'no-trail',
      'logging is explicitly turned off',
      'when somebody asks what happened, the answer will be that nobody knows',
      m[0],
      'medium',
    );
  }
  return out;
}

/** What reading a .tf file cannot settle, named so the silence is not mistaken for a pass. */
export const TERRAFORM_NOT_CHECKED = [
  'a value that arrives through a variable, a local or a data source: only a literal in the file is read',
  'modules from the registry or another repository, and whatever they open',
  'anything decided at apply time - a count, a for_each, a conditional',
  'the state file, and therefore what is actually running right now',
];
