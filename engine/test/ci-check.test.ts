// Phase 38: the verdict verbs, reachable from CI.
//
// Until this existed the Action could triage a failed run, build the team report and narrow a test
// run - and six of Tewip's strongest commands could not be reached from a workflow at all. That is
// the wrong way round: CI is where a team adopts a tool, and a migration reader that only runs on
// somebody's laptop reads very few migrations.
//
// What is tested here is mostly the restraint, as everywhere else. A check with nothing to look at
// must not read as a pass. A gate must fire on what a verb calls blocking and on nothing else,
// because a gate that fires on advice teaches a team to pass `continue-on-error` and then it never
// fires again. And a name Tewip has no verb for has to be said out loud rather than skipped.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECKS, chosenChecks, renderChecks, type Ran } from '../../ci/check.ts';
import { diffRange, type CiContext } from '../../ci/context.ts';
import { reportsIn } from '../../mcp/github-report.ts';

const ran = (id: string, over: Partial<Ran> = {}): Ran => {
  const check = CHECKS.find((c) => c.id === id)!;
  return { check, report: `${id} report`, blocking: false, idle: false, ...over };
};

describe('choosing which checks to run', () => {
  it('runs the one verdict over the whole change when nothing is named', () => {
    assert.deepEqual(chosenChecks('').checks.map((c) => c.id), ['done']);
    assert.deepEqual(chosenChecks('   ').checks.map((c) => c.id), ['done']);
  });

  it('reads a comma separated list, in the order it was asked for', () => {
    assert.deepEqual(chosenChecks('schema, access, vouch').checks.map((c) => c.id), ['schema', 'access', 'vouch']);
    assert.deepEqual(chosenChecks('vouch access').checks.map((c) => c.id), ['vouch', 'access']);
  });

  it('`all` means all of them, once each', () => {
    assert.deepEqual(chosenChecks('all').checks.map((c) => c.id), CHECKS.map((c) => c.id));
  });

  it('a name asked for before `all` keeps its place, and nothing runs twice', () => {
    const ids = chosenChecks('access, all, access').checks.map((c) => c.id);
    assert.equal(ids[0], 'access', 'what was asked for first runs first');
    assert.equal(new Set(ids).size, ids.length, 'nothing runs twice');
    assert.deepEqual([...ids].sort(), CHECKS.map((c) => c.id).sort());
  });

  it('a name it has no verb for is reported, not quietly dropped', () => {
    const { checks, unknown } = chosenChecks('access, lint, security');
    assert.deepEqual(checks.map((c) => c.id), ['access']);
    assert.deepEqual(unknown, ['lint', 'security']);
  });

  it('every check names a real verb and explains what "nothing to do" looks like', () => {
    for (const check of CHECKS) {
      assert.ok(check.verb.length > 2, check.id);
      assert.ok(check.title.endsWith('?'), `${check.id} should be phrased as the question it answers`);
      assert.ok(check.nothingToDo instanceof RegExp, check.id);
    }
  });

  it('exposes nothing that writes to the repository', () => {
    // The same rule as the A2A surface: CI runs this on every pull request, including from forks.
    const forbidden = ['fix', 'write', 'build', 'pursue', 'correct', 'jira'];
    for (const check of CHECKS) assert.ok(!forbidden.includes(check.verb), `${check.verb} changes things`);
  });
});

describe('the one comment a pull request gets', () => {
  it('leads with how many checks found something blocking', () => {
    const body = renderChecks([ran('schema', { blocking: true }), ran('access')], []);
    assert.match(body, /\*\*1 of 2 checks found something blocking\.\*\*/);
  });

  it('says plainly when nothing blocked, and how many checks had anything to read', () => {
    assert.match(renderChecks([ran('access'), ran('vouch')], []), /\*\*2 of 2 checks had something to look at, and found nothing blocking\.\*\*/);
  });

  it('a check with nothing to look at is neither a pass nor a failure', () => {
    const body = renderChecks([ran('schema', { idle: true, report: '' })], []);
    assert.match(body, /nothing to check/);
    assert.match(body, /Nothing in this change for it to look at/);
    assert.ok(!/blocking/.test(body.split('<details')[0].replace('nothing blocking', '')), 'the headline must not call it a pass');
  });

  // Phase 60: Tewip's own self-check workflow uploaded "**5 checks ran, nothing blocking.**" above
  // five checks of which three had seen no diff at all - the push range was empty. A reader takes
  // the headline as the verdict and never opens the collapsed sections.
  it('does not call a run of checks that read nothing a pass', () => {
    const body = renderChecks([ran('done', { idle: true, report: '' }), ran('schema', { idle: true, report: '' })], []);
    const headline = body.split('<details')[0];
    assert.match(headline, /none of them had anything to look at/);
    assert.match(headline, /That is not a pass: nothing was checked/);
    assert.match(headline, /fetch-depth: 0/, 'and the usual cause, so it can be fixed');
  });

  it('counts only the checks that had something in front of them', () => {
    const body = renderChecks([ran('access'), ran('vouch'), ran('schema', { idle: true, report: '' })], []);
    assert.match(body.split('<details')[0], /\*\*2 of 3 checks had something to look at/);
  });

  it('opens the blocking ones so nobody has to click to find the problem', () => {
    const body = renderChecks([ran('schema', { blocking: true }), ran('access')], []);
    assert.match(body, /<details open>[\s\S]*What will this migration do/);
    assert.match(body, /<details>\n<summary><b>Can everybody use this\?/);
  });

  it('names a check it does not have, and lists the ones it does', () => {
    const body = renderChecks([ran('access')], ['lint']);
    assert.match(body, /no check called `lint`/);
    for (const check of CHECKS) assert.ok(body.includes(`\`${check.id}\``), check.id);
  });

  it('never claims the change is correct', () => {
    const body = renderChecks([ran('done'), ran('access')], []);
    assert.match(body, /says what it did not check/);
    assert.match(body, /Nothing here is a claim that the change is correct/);
  });
});

// Phase 60: the range the change-based checks read.
//
// It was `origin/<base>...HEAD` everywhere, which is right for a pull request, right for a feature
// branch, and **empty on a push to the default branch** - there HEAD is origin/main. Gating pull
// requests and also checking main after a merge is a normal setup, and in half of it three of five
// checks were reading an empty diff and reporting "nothing to check".
describe('which range a check reads', () => {
  const ctx = (over: Partial<CiContext>): CiContext =>
    ({ branch: 'main', defaultBranch: 'main', pushedFrom: '', pr: null, ...over }) as CiContext;

  it('reads a pull request against its own base, not against the default branch', () => {
    const pr = { number: 7, headRef: 'feature', headSha: 'aaa', baseRef: 'release-2' };
    assert.equal(diffRange(ctx({ pr, branch: 'feature' })), 'origin/release-2...HEAD');
  });

  it('reads a branch against the default branch', () => {
    assert.equal(diffRange(ctx({ branch: 'feature' })), 'origin/main...HEAD');
  });

  it('reads a push to the default branch as the commits the push added', () => {
    // origin/main...HEAD here is empty, which is how a commit of ten files came to be checked as
    // "nothing in this change for it to look at".
    assert.equal(diffRange(ctx({ pushedFrom: 'a6f2e34' })), 'a6f2e34...HEAD');
  });

  it('falls back to the last commit when a push created the branch', () => {
    // GitHub sends all zeros for `before` on a branch's first push: not a commit to diff from.
    assert.equal(diffRange(ctx({ pushedFrom: '' })), 'HEAD~1...HEAD');
  });
});

// Phase 60: what `tewip ci` shows out of the artifact the Action uploaded.
//
// It rendered two hard-coded filenames, `pr-comment.md` and `infra.md`, which are what *triage*
// mode writes. Check mode writes six others under the same artifact name. Running
// `tewip ci hmamut39/tewip` against Tewip's own repository - whose self-check workflow runs in
// check mode - printed 167 characters: a title, a run link, and nothing underneath, out of an
// artifact holding 9KB of findings across six files.
describe('reading the Action\'s artifact', () => {
  const zip = (files: Record<string, string>) => new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v, 'utf8')]));

  it('shows the reports check mode writes, which are not the ones triage mode writes', () => {
    const found = reportsIn(zip({ 'checks.md': '## Tewip', 'vouch.md': 'could these fail', 'access.md': 'barriers', 'triage.json': '{}' }), 0);
    assert.deepEqual(found.map((r) => r.name), ['checks.md', 'access.md', 'vouch.md'], 'checks.md leads; the rest follow in a stable order');
  });

  it('leads with the comment written for a person when there is one', () => {
    const found = reportsIn(zip({ 'infra.md': 'the machines', 'pr-comment.md': 'why CI failed', 'checks.md': '## Tewip' }), 2);
    assert.deepEqual(found.map((r) => r.name), ['pr-comment.md', 'checks.md', 'infra.md']);
  });

  it('keeps infra.md behind its ENV count, because it is about the machines not the change', () => {
    assert.deepEqual(reportsIn(zip({ 'pr-comment.md': 'x', 'infra.md': 'the machines' }), 0).map((r) => r.name), ['pr-comment.md']);
  });

  it('skips a file the Action wrote empty rather than printing a bare heading', () => {
    // done.md in the real artifact was one byte: a newline.
    assert.deepEqual(reportsIn(zip({ 'checks.md': '## Tewip', 'done.md': String.fromCharCode(10) }), 0).map((r) => r.name), ['checks.md']);
  });

  it('finds nothing to show when the artifact holds nothing to show', () => {
    assert.deepEqual(reportsIn(zip({ 'triage.json': '{}', 'done.md': '' }), 0), [], 'and the caller then says what the artifact did hold');
  });
});
