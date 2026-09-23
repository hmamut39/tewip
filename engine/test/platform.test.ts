// Phase 13: being useful where the team already is. These tests are about the edges - reading the
// facts out of each CI, saying the right short thing in chat, and never shouting when nothing needs
// a person. The variables below are each platform's own documented ones.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ciFacts, detectPlatform } from '../ci/platform.ts';
import { GITLAB_MARKER, gitlabFromEnv } from '../ci/gitlab.ts';
import { chatMessage, slackPayload, teamsPayload } from '../notify/chat.ts';
import { looksLikeReport, newestReport } from '../watch/watch-command.ts';
import type { TriageItem } from '../../outlets/items.ts';

const item = (title: string, category: string, confidence = 0.9): TriageItem =>
  ({ title, testId: `suite > ${title}`, errorHead: 'expected 4 received 3', diagnosis: { category, confidence }, action: { summary: `File a bug against ${title}` } }) as unknown as TriageItem;

describe('reading whichever CI is running', () => {
  it('knows GitLab CI and takes the merge request from it', () => {
    const env = { GITLAB_CI: 'true', CI_PROJECT_PATH: 'team/shop', CI_PROJECT_ID: '42', CI_COMMIT_REF_NAME: 'feature/cart', CI_MERGE_REQUEST_IID: '7', CI_COMMIT_SHA: 'abc123', CI_JOB_URL: 'https://gitlab.com/team/shop/-/jobs/9' };
    assert.equal(detectPlatform(env), 'gitlab');
    const facts = ciFacts(env);
    assert.equal(facts.project, 'team/shop');
    assert.equal(facts.changeRequest, '7');
    assert.equal(facts.branch, 'feature/cart');
    assert.equal(facts.runUrl, 'https://gitlab.com/team/shop/-/jobs/9');
  });

  it('knows Jenkins, where the repository name only exists if the git plugin filled it in', () => {
    const env = { JENKINS_URL: 'http://ci/', BUILD_NUMBER: '88', JOB_NAME: 'shop-tests', GIT_BRANCH: 'origin/main', BUILD_URL: 'http://ci/job/shop/88/' };
    assert.equal(detectPlatform(env), 'jenkins');
    const facts = ciFacts(env);
    assert.equal(facts.branch, 'main', 'origin/ is not part of the branch name');
    assert.equal(facts.project, 'shop-tests');
    assert.equal(ciFacts({ ...env, GIT_URL: 'git@gitlab.com:team/shop.git' }).project, 'team/shop');
  });

  it('knows the other platforms teams actually use', () => {
    assert.equal(detectPlatform({ GITHUB_ACTIONS: 'true' }), 'github');
    assert.equal(detectPlatform({ CIRCLECI: 'true' }), 'circleci');
    assert.equal(detectPlatform({ TF_BUILD: 'True' }), 'azure');
    assert.equal(detectPlatform({ BITBUCKET_BUILD_NUMBER: '3' }), 'bitbucket');
    assert.equal(detectPlatform({ TRAVIS: 'true' }), 'travis');
    assert.equal(detectPlatform({ DRONE: 'true' }), 'drone');
    assert.equal(detectPlatform({}), 'local', 'no CI is a normal case, not an error');
  });

  it('does not accept the GitLab job token, which cannot post notes', () => {
    assert.equal(gitlabFromEnv({ CI_API_V4_URL: 'https://gitlab.com/api/v4', CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'job-token' }), null);
    const config = gitlabFromEnv({ CI_API_V4_URL: 'https://gitlab.com/api/v4', CI_PROJECT_ID: '42', TEWIP_GITLAB_TOKEN: 'real' });
    assert.equal(config?.token, 'real');
  });
});

describe('the message in the team chat', () => {
  const where = { project: 'team/shop', branch: 'main', runUrl: 'https://ci/run/9' };

  it('says how many need a person, and stays quiet when none do', () => {
    const flaky = [item('cart opens', 'TIMING'), item('search works', 'ENV')];
    const quiet = chatMessage(flaky, [], where);
    assert.equal(quiet.quiet, true, 'a run of known noise must not ping anyone');
    assert.match(quiet.headline, /none needs a person/);

    const real = item('checkout charges once', 'REAL_BUG');
    const loud = chatMessage([...flaky, real], [real], where);
    assert.equal(loud.quiet, false);
    assert.match(loud.headline, /1 failure needs a person on team\/shop · main/);
    assert.match(loud.lines.join('\n'), /checkout charges once/);
  });

  it('names the failures in plain words, not in category codes', () => {
    const drift = item('menu opens', 'LOCATOR_DRIFT');
    const message = chatMessage([drift], [drift], where);
    assert.match(message.headline, /renamed element/);
    assert.ok(!message.headline.includes('LOCATOR_DRIFT'));
  });

  it('writes each chat in its own shape', () => {
    const real = item('checkout charges once', 'REAL_BUG');
    const message = chatMessage([real], [real], where);
    const slack = JSON.stringify(slackPayload(message));
    assert.match(slack, /mrkdwn/);
    const teams = JSON.stringify(teamsPayload(message));
    assert.match(teams, /MessageCard/);
    assert.ok(!teams.includes('<https://ci/run/9|'), 'Teams does not read Slack link syntax');
  });

  it('marks its own merge request note so the next run edits it instead of piling up', () => {
    assert.match(GITLAB_MARKER, /tewip/);
  });
});

describe('watching for a report on your own machine', () => {
  it('finds the newest report among the places runners write them', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-watch-'));
    writeFileSync(join(root, 'report.xml'), '<testsuites/>', 'utf8');
    mkdirSync(join(root, 'test-results'));
    const newer = join(root, 'test-results', 'results.xml');
    writeFileSync(newer, '<testsuites/>', 'utf8');
    const later = new Date(Date.now() + 60_000);
    utimesSync(newer, later, later);
    assert.equal(newestReport(root)?.path, join(root, 'test-results'));
    assert.equal(newestReport(mkdtempSync(join(tmpdir(), 'tewip-empty-'))), null);
  });

  it('takes a report whatever it is called, and leaves other XML alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-watch-'));
    writeFileSync(join(root, 'pom.xml'), '<project><artifactId>shop</artifactId></project>', 'utf8');
    assert.equal(newestReport(root), null, 'a build file is not a test report');
    const report = join(root, 'node-jest.xml');
    writeFileSync(report, '<testsuites><testsuite name="shop"/></testsuites>', 'utf8');
    assert.equal(newestReport(root)?.path, report);
    assert.equal(looksLikeReport(join(root, 'pom.xml')), false);
  });
});
