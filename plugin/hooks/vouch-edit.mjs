// After Claude writes or edits a test, read it back and say if it cannot fail.
//
// This is the smallest useful thing Tewip can do inside an agent's own loop, and it is aimed at the
// failure mode that agentic coding actually has. A model that is asked to make a suite pass can do
// it by writing a test that cannot fail - one with no assertion, one that asserts a constant, one
// whose only check sits behind a `catch` that swallows it. It passes, it counts toward coverage, it
// looks like work, and nobody reads it again. `tewip vouch` is the check for exactly that, it needs
// no model, and it takes about a second.
//
// Three rules this hook holds itself to, because a hook that breaks somebody's session is worse
// than no hook:
//
//   1. It never fails the tool call. Every path exits 0.
//   2. It says nothing unless it has something to say - no "all clear" noise on every edit.
//   3. It never runs on a file that is not a test, so the common edit costs nothing.
//
// Written in Node rather than sh or python: Tewip already requires Node, and the people most likely
// to install this are on Windows, where `sh` is not a given.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Read the hook payload, which arrives on stdin as one JSON object. */
async function payload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Does this path look like a test?
 *
 * Name conventions only, and deliberately: the alternative is reading every file Claude writes,
 * which is the cost this hook exists to avoid. A false negative here means a missed warning; a
 * false positive means a second of work on a file that had none to do. Both are cheap.
 */
const LOOKS_LIKE_A_TEST = /(?:\.|_|-)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[/\\])test_[^/\\]+\.py$|[^/\\]+_test\.(?:py|go|rb)$|(?:^|[/\\])(?:tests?|spec|__tests__)[/\\].+\.[cm]?[jt]sx?$|Test\.(?:java|kt|cs)$/i;

/** The command, preferring one already installed over one fetched on every edit. */
function tewip(args) {
  // `TEWIP_CMD` first, so a project can pin the binary it trusts and so this hook can be tested
  // against a build that is not the published one. Then whatever is on PATH, then npx - which is
  // correct and slow, and is the reason it is last.
  const override = process.env.TEWIP_CMD;
  if (override) return spawnSync(override, args, { encoding: 'utf8', shell: true, timeout: 60_000 });
  const onPath = spawnSync('tewip', ['--version'], { encoding: 'utf8', shell: true, timeout: 10_000 });
  const run = onPath.status === 0 ? ['tewip', args] : ['npx', ['-y', 'tewip-ai@latest', ...args]];
  return spawnSync(run[0], run[1], { encoding: 'utf8', shell: true, timeout: 60_000 });
}

const data = await payload();
const file = data?.tool_input?.file_path;
// Nothing to do, and nothing to say about it.
if (!file || !existsSync(file) || !LOOKS_LIKE_A_TEST.test(file)) process.exit(0);

const out = tewip(['vouch', file]);
if (out.status !== 0 || !out.stdout) process.exit(0);

// The one line worth interrupting for. `vouch` prints a count of tests that cannot fail at all;
// anything else it says is for a person reading the whole report, not for this moment.
const cannot = /\*\*(\d+) cannot fail at all\.\*\*/.exec(out.stdout);
const count = cannot ? Number(cannot[1]) : 0;
if (count > 0) {
  const names = [...out.stdout.matchAll(/^- \*\*([^*]+)\*\*/gm)].slice(0, 3).map((m) => m[1]);
  process.stdout.write(
    `Tewip: ${count} test(s) in ${file} cannot fail${names.length > 0 ? ` — ${names.join(', ')}` : ''}. ` +
      `A test that cannot fail still passes and still counts toward coverage. Run \`tewip vouch ${file}\` for the evidence.\n`,
  );
}
process.exit(0);
