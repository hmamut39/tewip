// Turning proved work into a pull request - the last step of the loop, and the one where Tewip
// touches somebody's repository, so it is the most careful.
//
// Three rules, enforced here rather than promised:
//   it only ever pushes a new branch of its own, never yours;
//   it never merges, and opens the request as a draft so nobody can merge it by reflex;
//   it describes exactly what was proved and what was not, because a pull request nobody can check
//   is worse than a patch file.
//
// The work must already be proved before anything reaches this file. Nothing here runs a test or
// decides anything; it commits what was verified and opens the request.
import { spawnSync } from 'node:child_process';

export interface ProposeInput {
  root: string;
  /** Files to commit, relative to the root. */
  files: string[];
  /** The one-line subject, e.g. "add a sep argument to naturalsize". */
  title: string;
  /** What was proved, in the words of whoever proved it. */
  body: string;
  /** A ticket this came from, mentioned in the request so a person can find it. */
  issue?: string;
}

export interface ProposeResult {
  status: 'opened' | 'committed' | 'refused';
  branch?: string;
  url?: string;
  /** What to do next, when Tewip could not finish the job itself. */
  next: string[];
}

const run = (cwd: string, command: string, args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/** A branch name a person can read at a glance, and that cannot collide with an existing one. */
export function branchNameFor(title: string, now = new Date()): string {
  const stem = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'change';
  return `tewip/${stem}-${now.toISOString().slice(2, 16).replace(/\D/g, '')}`;
}

/** The pull request body: what was built, and precisely how far the proof goes. */
export function requestBody(body: string, files: string[], issue?: string): string {
  return [
    body,
    '',
    `Files: ${files.map((f) => `\`${f}\``).join(', ')}`,
    issue ? `From: ${issue}` : '',
    '',
    '---',
    '',
    'Written by Tewip and kept only because it was proved: the test failed without this change and',
    'passes with it, and every test that was passing still passes.',
    '',
    'What that does **not** say: whether this is the design you want, whether it is the right place',
    'for it, or whether it is complete. That is what your review is for. This is a draft on a branch',
    'of its own; Tewip never merges anything.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Commits the proved files on a fresh branch and opens a draft pull request with the `gh` CLI the
 * developer is already logged into. When there is no `gh`, the branch is still pushed and the
 * command to open the request by hand is printed - half a job done is better than a silent failure.
 */
export function proposePullRequest(input: ProposeInput): ProposeResult {
  const { root, files } = input;
  if (files.length === 0) return { status: 'refused', next: ['there was nothing to commit'] };
  if (!run(root, 'git', ['rev-parse', '--git-dir']).ok) return { status: 'refused', next: ['this is not a git checkout, so there is no branch to open a request from'] };

  const branch = branchNameFor(input.title);
  const base = run(root, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || 'main';

  // A branch of Tewip's own, from wherever the person is standing. Their branch is never committed to.
  const made = run(root, 'git', ['checkout', '-b', branch]);
  if (!made.ok) return { status: 'refused', next: [`could not create the branch ${branch}: ${made.out.slice(0, 200)}`] };

  const added = run(root, 'git', ['add', '--', ...files]);
  if (!added.ok) {
    run(root, 'git', ['checkout', base]);
    return { status: 'refused', next: [`could not stage the files: ${added.out.slice(0, 200)}`] };
  }
  // Only Tewip's own files are committed: anything else the person had in progress stays theirs.
  const committed = run(root, 'git', ['commit', '-m', input.title, '-m', requestBody(input.body, files, input.issue), '--only', '--', ...files]);
  if (!committed.ok) {
    run(root, 'git', ['checkout', base]);
    return { status: 'refused', next: [`could not commit: ${committed.out.slice(0, 200)}`] };
  }

  const next: string[] = [];
  const pushed = run(root, 'git', ['push', '-u', 'origin', branch]);
  if (!pushed.ok) {
    return {
      status: 'committed',
      branch,
      next: [`the work is committed on ${branch}, but pushing failed: ${pushed.out.slice(0, 200)}`, `push it yourself with: git push -u origin ${branch}`],
    };
  }

  const gh = run(root, 'gh', ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', input.title, '--body', requestBody(input.body, files, input.issue)]);
  if (gh.ok) {
    const url = (gh.out.match(/https:\/\/\S+/) ?? [])[0];
    return { status: 'opened', branch, url, next: [`review it: ${url ?? branch}`, `back to where you were: git checkout ${base}`] };
  }
  next.push(`${branch} is pushed, but the pull request was not opened: ${gh.out.slice(0, 200)}`);
  next.push(`open it with: gh pr create --draft --base ${base} --head ${branch}`);
  next.push(`back to where you were: git checkout ${base}`);
  return { status: 'committed', branch, next };
}
