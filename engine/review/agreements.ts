// Agreements a change renegotiates outside the tests.
//
// The test version of this reads assertions, because a test is an agreement written down. It is not
// the only one. A default someone chose, a guard that refuses bad input, a version pinned on
// purpose, a permission deliberately kept narrow - each is a decision the project already made, and
// each can be undone in one line of a diff that reads like housekeeping. The pull request that
// prompted all of this shipped a wrong rule with its tests updated to match; the same shape appears
// when a timeout doubles or a `required` becomes optional and nobody says why.
//
// What this refuses to be is a linter. It reports only changes to things that were already decided
// - never additions, never new files - and it asks rather than judges. The test that keeps it
// honest is the noise measurement: run over eighteen real pull requests, it has to stay quiet on
// the ordinary ones or a team will learn to scroll past it.
import { execFileSync } from 'node:child_process';

export interface Agreement {
  file: string;
  kind: 'default' | 'guard' | 'permission' | 'pin' | 'limit';
  /** What the project had decided, and what the change makes of it. */
  before: string;
  after: string;
  /** Why this one is worth a reviewer's eye, in a sentence. */
  why: string;
}

const NOT_SOURCE = /(\.spec\.|\.test\.|_test\.|test_|\/tests?\/|\/e2e\/|\/cypress\/|\.md$|\.snap$|lock(file)?$|package-lock\.json$|yarn\.lock$|\.sum$)/i;

/** An exported or module-level constant, and a parameter's default: values other code relies on. */
const DEFAULT_VALUE = /^\s*(?:export\s+)?(?:const|let|var|final|static|public|private)?\s*([A-Z][A-Z0-9_]{2,}|[\w$]+)\s*(?::[^=]+)?=\s*(.+?);?\s*$/;
const PARAM_DEFAULT = /\b([\w$]+)\s*(?::[^=,)]+)?=\s*([^,)]+)[,)]/;
/** A refusal: the code declining to accept something. */
const GUARD = /\b(?:throw|raise|panic|abort|reject|assert|invariant|require)\b|\bif\s*\(![\w$.]+\)/;
/** Who is allowed to do what. */
const PERMISSION = /\b(?:permissions?|scope|role|allow[_-]?origin|cors|public|private|protected|readonly|auth|admin|policy|rls|chmod|0o?7[0-7][0-7])\b/i;
/**
 * A version deliberately pinned - and, in the same family, the thing a job is deliberately run on.
 * `runs-on: macos-14` carries no dotted version but is exactly the same kind of decision, and one
 * real pull request in the measurement set bumped it to `macos-26` by accident and was reverted
 * for it, which is how this case was found.
 */
const PIN = /["']?[~^>=<]*\d+\.\d+(\.\d+)?["']?/;
const RUNS_ON = /^\s*(?:-\s*)?(?:runs-on|image|container|uses|FROM|baseImage|node-version|python-version|go-version)\b\s*[:=]?\s*\S/i;
const PIN_FILE = /(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|Gemfile|Cargo\.toml|build\.gradle|pom\.xml|Dockerfile|\.ya?ml)$/i;
/** Numbers that decide behaviour under load rather than logic. */
const LIMIT = /\b(?:timeout|retries|retry|max|min|limit|ttl|interval|delay|backoff|threshold|concurrency|workers|pool|buffer|size)\b/i;

/**
 * Markup and styling, where the words this looks for mean something else entirely. Measured against
 * 30 ordinary pull requests, `className="min-w-0 flex-1"` becoming `min-w-[9rem]` was reported as a
 * limit that decides behaviour under load - which is the kind of noise that teaches people to
 * scroll past a review.
 */
const MARKUP = /\bclassName\s*=|\bclass\s*=|\bstyle\s*=|<\/?[a-zA-Z][\w-]*[\s/>]|\.(?:css|scss|sass|less|html|svg)$/;

/**
 * The words in a line, with identifiers pulled apart. `MAX_RETRIES` and `maxRetries` are the same
 * decision as `max retries`, but an underscore is a word character, so a plain \bretries\b matches
 * neither - which silently classified a retry count as an ordinary default.
 */
const words = (line: string): string => line.replace(/[_-]+/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2');

const clean = (line: string): string => line.trim().slice(0, 150);

/** Pairs a removed line with the added line that replaced it, by position within the hunk. */
function pairs(removed: string[], added: string[]): Array<[string, string]> {
  return removed.map((line, i) => [line, added[i] ?? ''] as [string, string]);
}

/** Two lines that are the same statement with a different value: that is a decision being changed. */
function sameStatement(before: string, after: string): boolean {
  const shape = (s: string) => s.replace(/["'`][^"'`]*["'`]/g, 'S').replace(/\b\d+(\.\d+)*\b/g, 'N').replace(/\s+/g, ' ').trim();
  return Boolean(after) && shape(before) === shape(after) && before.trim() !== after.trim();
}

function classify(file: string, before: string, after: string): Agreement | null {
  const both = `${before} ${after}`;
  if (MARKUP.test(both) || MARKUP.test(file)) return null;
  if (!after) {
    // Something was removed outright. Only a refusal is worth reporting: deleted code is the
    // ordinary business of a diff, but a deleted guard changes what the system accepts.
    return GUARD.test(before)
      ? { file, kind: 'guard', before: clean(before), after: '', why: 'a check that refused something was removed, so input the project used to reject is now accepted' }
      : null;
  }
  if (!sameStatement(before, after)) return null;

  if (GUARD.test(before) || GUARD.test(after)) {
    return { file, kind: 'guard', before: clean(before), after: clean(after), why: 'the condition on which the code refuses something changed' };
  }
  if (PERMISSION.test(words(both))) {
    return { file, kind: 'permission', before: clean(before), after: clean(after), why: 'who or what is allowed here changed' };
  }
  if (PIN_FILE.test(file) && (PIN.test(before) || RUNS_ON.test(before))) {
    return {
      file,
      kind: 'pin',
      before: clean(before),
      after: clean(after),
      why: RUNS_ON.test(before) ? 'what this runs on changed' : 'a version that was pinned deliberately moved',
    };
  }
  if (LIMIT.test(words(both))) {
    return { file, kind: 'limit', before: clean(before), after: clean(after), why: 'a limit that decides behaviour under load changed' };
  }
  if (DEFAULT_VALUE.test(before) || PARAM_DEFAULT.test(before)) {
    return { file, kind: 'default', before: clean(before), after: clean(after), why: 'a value other code falls back on changed' };
  }
  return null;
}

function sourceDiff(root: string, range: string): string {
  try {
    return execFileSync('git', ['diff', '--unified=0', range, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

/** Decisions this change alters, outside the tests. Additions and new files are never reported. */
export function changedAgreements(root: string, range: string, diff = sourceDiff(root, range)): Agreement[] {
  const out: Agreement[] = [];
  let file = '';
  let isNew = false;
  let removed: string[] = [];
  let added: string[] = [];

  const flush = (): void => {
    if (file && !isNew && !NOT_SOURCE.test(file)) {
      for (const [before, after] of pairs(removed, added)) {
        const found = classify(file, before, after);
        if (found) out.push(found);
      }
    }
    removed = [];
    added = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      flush();
      file = /b\/(\S+)/.exec(line)?.[1] ?? '';
      isNew = false;
      continue;
    }
    if (line.startsWith('new file mode')) isNew = true;
    if (line.startsWith('@@')) flush();
    if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
    else if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  flush();
  return out;
}

const HEADING: Record<Agreement['kind'], string> = {
  guard: 'checks that refused something',
  permission: 'who is allowed what',
  pin: 'versions pinned on purpose',
  limit: 'limits that decide behaviour under load',
  default: 'values other code falls back on',
};

/** Sentences for a reviewer. As with the tests, this asks; it never decides. */
export function renderAgreements(agreements: Agreement[]): string[] {
  if (agreements.length === 0) return [];
  const lines = ['## Decisions this change alters', ''];
  const kinds = [...new Set(agreements.map((a) => a.kind))];
  lines.push(
    `Outside the tests, this change alters ${agreements.length} thing(s) the project had already decided: ${kinds.map((k) => HEADING[k]).join(', ')}. Each may be exactly what was intended - the point is that a diff makes them look like housekeeping.`,
    '',
  );
  for (const agreement of agreements.slice(0, 10)) {
    lines.push(`- **${agreement.file.split('/').at(-1)}** — ${agreement.why}`);
    lines.push(`  - was: \`${agreement.before}\``);
    if (agreement.after) lines.push(`  - now: \`${agreement.after}\``);
  }
  lines.push('', 'Ask the author which of these the change needed.');
  return lines;
}
