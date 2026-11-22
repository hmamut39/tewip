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
/**
 * A Dockerfile, which is not a source file about Dockerfiles.
 *
 * `^dockerfile($|[.-])` matches `dockerfile.ts` - `.` is in that class - so Tewip read its own
 * `engine/iac/dockerfile.ts` as a Dockerfile and reported "1 Dockerfile" on a repository that has
 * none. Any project with a module named after the thing it handles had the same problem, and the
 * instructions parser would then find whatever a source file happened to contain.
 *
 * A real one is `Dockerfile`, `Dockerfile.prod`, or `something.dockerfile`. None of those ends in
 * a code extension.
 */
import { lines as splitLines } from '../lines.ts';

const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|php|swift|md|txt|snap)$/i;
export const isDockerfile = (name: string): boolean =>
  !CODE.test(name) && (/^dockerfile($|[.-])/i.test(name) || /\.dockerfile$/i.test(name));

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
  const lines = splitLines(source);
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

/** Each stage declared in this file, by its lowercased name, as the instructions that follow it. */
function stagesOf(all: Instruction[]): Map<string, Instruction[]> {
  const out = new Map<string, Instruction[]>();
  const starts = all.map((x, i) => (x.keyword === 'FROM' ? i : -1)).filter((i) => i >= 0);
  for (const [n, at] of starts.entries()) {
    const name = /\sAS\s+(\S+)\s*$/i.exec(all[at].rest)?.[1]?.toLowerCase();
    if (name) out.set(name, all.slice(at, starts[n + 1] ?? all.length));
  }
  return out;
}

/**
 * The USER in force at the end of a stage, following `FROM` back through stages in this file.
 *
 * Docker inherits USER from the parent stage, and reading only the final stage does not. So
 *
 *     FROM node:22 AS base
 *     USER node
 *     FROM base AS prod
 *     COPY . .
 *
 * was reported as **"this image has no USER, so everything in it runs as root"** - about an image
 * that runs as `node`. A high-severity false accusation, and the kind that is read and acted on,
 * because "your container runs as root" is a sentence somebody takes to their platform team.
 *
 * Found in Phase 212 while reading what `infra` says about immich. Its own Dockerfiles set no USER
 * anywhere, so every finding there was right; this is the case next door that was not, and no
 * repository in the corpus had it.
 *
 * A chain that leaves this file - a registry image - ends the walk: what that image sets is not
 * readable from here, which is the honest limit and is now printed with the findings.
 */
function userInForce(stages: Map<string, Instruction[]>, stage: Instruction[], seen = new Set<string>()): Instruction | null {
  const users = stage.filter((x) => x.keyword === 'USER');
  if (users.length > 0) return users[users.length - 1];
  const from = stage.find((x) => x.keyword === 'FROM');
  if (!from) return null;
  const parent = from.rest.split(/\s+/)[0]?.toLowerCase();
  // A name this file declares, and not one already walked: `FROM a AS b` / `FROM b AS a` loops.
  if (!parent || !stages.has(parent) || seen.has(parent)) return null;
  seen.add(parent);
  return userInForce(stages, stages.get(parent) as Instruction[], seen);
}

export function readDockerfile(file: string, source: string): IacFinding[] {
  const all = instructionsOf(source);
  if (all.length === 0) return [];
  const found: IacFinding[] = [];
  const shipped = lastStage(all);
  /** Stage names this file declares, so a later FROM pointing at one is not a registry pull. */
  const stages = new Set(all.filter((x) => x.keyword === 'FROM').map((x) => /\sAS\s+(\S+)\s*$/i.exec(x.rest)?.[1]?.toLowerCase()).filter((n): n is string => Boolean(n)));
  const add = (i: Instruction, rule: string, what: string, because: string, risk: 'high' | 'medium' = 'medium') =>
    found.push({ file, line: i.line, rule, what, because, evidence: i.text.slice(0, 160), risk });

  // Who the process is. Only the last stage ships - a builder running as root ships nothing - but
  // the last stage inherits the USER of the stage it is built FROM, so the chain is followed.
  const last = userInForce(stagesOf(all), shipped);
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
