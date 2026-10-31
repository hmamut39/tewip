// What a Dockerfile lets in, read from the file and nothing else.
//
// Container scanners mostly report two kinds of thing: CVEs in the base image, which needs a
// registry and a vulnerability feed, and "best practices", which is a long list of opinions. This
// does neither. It reports the few things that are certain from the text in front of it and that
// change what an attacker can do once they are inside, and it says nothing about the rest.
//
// The rule that keeps it honest: every finding quotes the line it came from, and an absence is
// only reported when the absence is the finding - a Dockerfile with no USER really does run as
// root, and that is a fact about the file rather than a guess about the image.
export interface IacFinding {
  file: string;
  line: number;
  rule: string;
  /** What is true, in one line. */
  what: string;
  /** Why it matters when somebody is already inside. */
  because: string;
  /** The line as written, so nothing has to be believed. */
  evidence: string;
  risk: 'high' | 'medium';
}

interface Instruction {
  line: number;
  keyword: string;
  rest: string;
  text: string;
}

/** Instructions, with continuations joined, because a RUN can span twenty lines. */
export function instructionsOf(source: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = source.split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\s*(#|$)/.test(raw)) continue;
    let text = raw.trim();
    let at = i;
    while (/\\\s*$/.test(text) && at + 1 < lines.length) {
      at += 1;
      text = `${text.replace(/\\\s*$/, ' ')}${lines[at].trim()}`;
    }
    const m = /^([A-Za-z]+)\s+([\s\S]*)$/.exec(text);
    if (m) out.push({ line: i + 1, keyword: m[1].toUpperCase(), rest: m[2].trim(), text });
    i = at;
  }
  return out;
}

/** The final stage's instructions: earlier stages are builders and do not ship. */
function lastStage(all: Instruction[]): Instruction[] {
  const starts = all.map((x, i) => (x.keyword === 'FROM' ? i : -1)).filter((i) => i >= 0);
  return starts.length === 0 ? all : all.slice(starts[starts.length - 1]);
}

const ROOT = /^(root|0)(:|$)/;

export function readDockerfile(file: string, source: string): IacFinding[] {
  const all = instructionsOf(source);
  if (all.length === 0) return [];
  const found: IacFinding[] = [];
  const shipped = lastStage(all);
  /** Stage names this file declares, so a later FROM pointing at one is not a registry pull. */
  const stages = new Set(all.filter((x) => x.keyword === 'FROM').map((x) => /\sAS\s+(\S+)\s*$/i.exec(x.rest)?.[1]?.toLowerCase()).filter((n): n is string => Boolean(n)));
  const add = (i: Instruction, rule: string, what: string, because: string, risk: 'high' | 'medium' = 'medium') =>
    found.push({ file, line: i.line, rule, what, because, evidence: i.text.slice(0, 160), risk });

  // Who the process is. Only the last stage matters: a builder running as root ships nothing.
  const users = shipped.filter((x) => x.keyword === 'USER');
  const last = users[users.length - 1];
  const from = shipped.find((x) => x.keyword === 'FROM');
  if (!last && from) {
    found.push({
      file,
      line: from.line,
      rule: 'runs-as-root',
      what: 'this image has no USER, so everything in it runs as root',
      because: 'a flaw in the application is then a flaw with root in the container, and root in the container is one kernel bug from root on the host',
      evidence: from.text.slice(0, 160),
      risk: 'high',
    });
  } else if (last && ROOT.test(last.rest)) {
    add(last, 'runs-as-root', 'the last USER in this image is root', 'a flaw in the application is then a flaw with root in the container, and root in the container is one kernel bug from root on the host', 'high');
  }

  for (const i of shipped) {
    if (i.keyword === 'FROM') {
      const image = i.rest.split(/\s+/)[0];
      // `FROM prod-${DEVICE} AS prod` in immich's machine-learning image is a reference to an
      // earlier stage of this same build, not a registry image, and calling it an unpinned base
      // is a false accusation about a line that pulls nothing. A stage name has no tag by
      // definition, so without this every multi-stage Dockerfile reports one of these.
      if (image === 'scratch' || stages.has(image.toLowerCase())) continue;
      // An interpolated name cannot be resolved here, and a guess either way would be invented.
      if (image.includes('$')) continue;
      if (!image.includes('@sha256:') && (/:latest$/.test(image) || !image.includes(':'))) {
        add(i, 'unpinned-base', `the base image ${image} is not pinned to a version`, 'the image you tested and the image you deploy are then two different things, and nothing records which one shipped');
      }
    }
    if (i.keyword === 'ADD' && /\bhttps?:\/\//.test(i.rest)) {
      add(i, 'add-from-url', 'ADD fetches a file over the network into the image', 'the download is not verified, and whatever that URL serves on build day is what ships', 'medium');
    }
    if (i.keyword === 'RUN' && /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/.test(i.rest)) {
      add(i, 'pipe-to-shell', 'a download is piped straight into a shell', 'whatever that server returns is executed as part of the build, with no signature and no record of what it was', 'high');
    }
  }
  return found;
}
