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

  it('says plainly when nothing blocked', () => {
    assert.match(renderChecks([ran('access'), ran('vouch')], []), /\*\*2 checks ran, nothing blocking\.\*\*/);
  });

  it('a check with nothing to look at is neither a pass nor a failure', () => {
    const body = renderChecks([ran('schema', { idle: true, report: '' })], []);
    assert.match(body, /nothing to check/);
    assert.match(body, /Nothing in this change for it to look at/);
    assert.ok(!/blocking/.test(body.split('<details')[0].replace('nothing blocking', '')), 'the headline must not call it a pass');
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
