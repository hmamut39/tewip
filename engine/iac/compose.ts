// What a docker-compose file hands a container, read from the file.
//
// Four rules, each one a fact about the text and each one a real change in what an attacker can
// reach from inside a container. No opinions about restart policies or healthchecks: those are
// somebody's house style, and a security report padded with house style is one nobody finishes.
//
// Read line by line rather than through a YAML parser. The shapes needed are one key deep, the
// files are full of `${VAR}` interpolation that a strict parser rejects, and adding a dependency
// to this project to read four keys would be the wrong trade. Comments are stripped first, so a
// rule written in prose above a service does not become a finding about it.
import { lines as splitLines } from '../lines.ts';
import type { IacFinding } from './dockerfile.ts';

/** The line with `#` comments removed, unless the `#` is inside quotes. */
function bare(line: string): string {
  let out = '';
  let quote = '';
  for (const ch of line) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') break;
    out += ch;
  }
  return out;
}

/**
 * The capability names that matter, as a scanner rather than a line match.
 *
 * Used for the inline form `cap_add: ["SYS_ADMIN"]`, which is how Compose's own reference writes a
 * short list. The block form keeps its own anchored pattern below, because there a bare name on a
 * line is the whole statement and anchoring is what stops prose matching.
 */
const DANGEROUS = /\b(?:SYS_ADMIN|SYS_PTRACE|SYS_MODULE|NET_ADMIN|DAC_READ_SEARCH)\b/g;

interface Rule {
  rule: string;
  re: RegExp;
  what: string;
  because: string;
  risk: 'high' | 'medium';
}

/**
 * Named rather than looked up out of `RULES` below, which it is also a member of.
 *
 * The inline form needs this rule's wording without matching its line pattern, and a
 * `RULES.find(...)` for it is a lookup that can return undefined - which would make a renamed rule
 * silently stop reporting rather than fail to compile.
 */
const CAPABILITY: Rule = {
  rule: 'dangerous-capability',
  re: /^\s*-\s*["']?(SYS_ADMIN|SYS_PTRACE|SYS_MODULE|NET_ADMIN|DAC_READ_SEARCH)["']?\s*$/,
  what: 'a container is given a capability that undoes the sandbox',
  because: 'SYS_ADMIN and SYS_MODULE are close to root on the host; SYS_PTRACE and DAC_READ_SEARCH read other processes and files the container should not see',
  risk: 'medium',
};

const RULES: Rule[] = [
  {
    rule: 'docker-socket',
    re: /\/var\/run\/docker\.sock/,
    what: 'the Docker socket is mounted into a container',
    because: 'anything inside can then start a container as root on the host with the whole filesystem mounted. This is not a privilege boundary; it is the absence of one',
    risk: 'high',
  },
  {
    rule: 'privileged',
    re: /^\s*privileged\s*:\s*(?:true|yes|"true"|'true')\s*$/i,
    what: 'a container runs privileged',
    because: 'it keeps every kernel capability and sees the host devices, so the container boundary stops being a boundary',
    risk: 'high',
  },
  {
    rule: 'host-network',
    re: /^\s*network_mode\s*:\s*["']?host["']?\s*$/i,
    what: 'a container shares the host network',
    because: 'it reaches anything bound to localhost on the host, which is usually where the unauthenticated admin ports are',
    risk: 'high',
  },
  CAPABILITY,
];

export function readCompose(file: string, source: string): IacFinding[] {
  const found: IacFinding[] = [];
  const lines = splitLines(source);
  // `cap_add:` is the only place a capability name means what the rule says. The same word under
  // `cap_drop:` is the opposite - a container dropping SYS_ADMIN is doing the right thing, and
  // reporting that as a finding would be exactly backwards.
  let inCapAdd = false;
  for (const [i, raw] of lines.entries()) {
    const line = bare(raw);
    const capAdd = /^\s*cap_add\s*:(.*)$/.exec(line);
    if (capAdd) {
      const inline = capAdd[1].trim();
      // A block list follows on the next lines only when nothing follows the colon here.
      inCapAdd = inline === '';
      // `cap_add: ["SYS_ADMIN"]` grants exactly what the block form grants, and this rule used to
      // miss it entirely: the `continue` that set the block flag consumed the line before any rule
      // read it. Measured in eval/container-recall.ts, which is why it is a line of code now.
      // `.match`, not `.test`: `DANGEROUS` carries the `g` flag, and `.test` on a global regex
      // advances `lastIndex` between calls, so the second file scanned would get a different
      // answer from the first. `.match` resets it.
      if (inline.match(DANGEROUS) !== null) {
        found.push({
          file,
          line: i + 1,
          rule: CAPABILITY.rule,
          what: CAPABILITY.what,
          because: CAPABILITY.because,
          evidence: line.trim().slice(0, 160),
          risk: CAPABILITY.risk,
        });
      }
      continue;
    }
    if (/^\s*[a-z_]+\s*:/i.test(line) && !/^\s*-/.test(line)) inCapAdd = false;
    for (const r of RULES) {
      if (r.rule === 'dangerous-capability' && !inCapAdd) continue;
      if (!r.re.test(line)) continue;
      found.push({ file, line: i + 1, rule: r.rule, what: r.what, because: r.because, evidence: line.trim().slice(0, 160), risk: r.risk });
    }
  }
  return found;
}
