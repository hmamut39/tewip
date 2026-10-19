// The three answers a distribution channel can give, and the one that used to be missing.
//
// The standing rule on this project is to check every channel after every improvement, because a
// stale channel looks exactly like a current one. Doing it by hand failed twice in a single day -
// not by being skipped, but by asking the MCP registry a question that returns a capped version
// history. It answered with a plausible version number that was two releases old, and it would
// have answered just as plausibly if nothing were wrong.
//
// So `unverified` is a first-class verdict here, and these tests exist mostly to hold it apart from
// `current`. Folding an unanswered query into "fine" is the whole failure.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, judge, renderChannels, type ChannelReading } from '../release/channels.ts';

const NL = String.fromCharCode(10);
const reading = (over: Partial<ChannelReading> = {}): ChannelReading =>
  ({ name: 'npm', expected: '0.70.14', actual: '0.70.14', asked: 'GET /x', ...over });

describe('what a channel answered', () => {
  it('is current when it carries the expected version', () => {
    const v = judge(reading());
    assert.equal(v.verdict, 'current');
    assert.match(v.says, /has 0\.70\.14/);
  });

  it('is behind when it carries an older one, and says which', () => {
    const v = judge(reading({ actual: '0.70.12' }));
    assert.equal(v.verdict, 'behind');
    assert.match(v.says, /has 0\.70\.12, but this repository is at 0\.70\.14/);
    assert.match(v.says, /did not reach it/);
  });

  it('is ahead, not broken, when it carries a newer one', () => {
    // The editor extension keeps its own version line, and a checkout can legitimately be behind
    // what is published. That is not a release failure and must not be reported as one.
    assert.equal(judge(reading({ actual: '0.71.0' })).verdict, 'ahead');
  });

  it('is unverified when it could not be read, and refuses to call that fine', () => {
    const v = judge(reading({ actual: null, problem: 'the registry answered 503' }));
    assert.equal(v.verdict, 'unverified');
    assert.match(v.says, /503/);
    assert.match(v.says, /not the same as being up to date/);
  });
});

describe('comparing versions', () => {
  it('orders by number, not by text', () => {
    // '0.70.9' > '0.70.14' as strings. This is the comparison the whole verdict rests on.
    assert.equal(compareVersions('0.70.9', '0.70.14') < 0, true);
    assert.equal(compareVersions('0.70.14', '0.70.9') > 0, true);
    assert.equal(compareVersions('0.70.14', '0.70.14'), 0);
  });

  it('treats a missing part as zero', () => {
    assert.equal(compareVersions('0.70', '0.70.1') < 0, true);
    assert.equal(compareVersions('0.70', '0.70.0'), 0);
  });
});

describe('the report a person reads', () => {
  const four = (): ChannelReading[] => [
    reading({ name: 'npm' }),
    reading({ name: 'MCP registry' }),
    reading({ name: 'Open VSX', expected: '0.13.0', actual: '0.13.0' }),
    reading({ name: 'VS Code Marketplace', expected: '0.13.0', actual: '0.13.0' }),
  ];

  it('says so plainly when everything is current', () => {
    const out = renderChannels(four());
    assert.equal(out.behind, 0);
    assert.equal(out.unverified, 0);
    assert.match(out.text, /Every channel answered, and every one has this release\./);
  });

  it('counts a channel that missed the release', () => {
    const readings = four();
    readings[1] = reading({ name: 'MCP registry', actual: '0.70.12' });
    const out = renderChannels(readings);
    assert.equal(out.behind, 1);
    assert.match(out.text, /1 channel\(s\) did not get this release: MCP registry/);
    assert.doesNotMatch(out.text, /Every channel answered/);
  });

  it('counts an unreadable channel separately from a stale one', () => {
    // Folding these together is how an unanswered query becomes a clean report, so they are
    // counted apart and said apart.
    const readings = four();
    readings[1] = reading({ name: 'MCP registry', actual: null, problem: 'timeout' });
    readings[2] = reading({ name: 'Open VSX', expected: '0.13.0', actual: '0.12.0' });
    const out = renderChannels(readings);
    assert.equal(out.behind, 1);
    assert.equal(out.unverified, 1);
    assert.match(out.text, /did not get this release: Open VSX/);
    assert.match(out.text, /could not be checked at all: MCP registry/);
    assert.match(out.text, /Nothing above says whether those are current/);
  });

  it('prints the question it asked, not only the answer', () => {
    // The wrong question is what went undetected for two releases. A question nobody can see is a
    // question nobody can correct.
    const out = renderChannels([reading({ asked: 'GET /v0/servers?search=<name>&version=latest' })]);
    assert.match(out.text, /How each was asked:/);
    assert.match(out.text, /npm: GET \/v0\/servers\?search=<name>&version=latest/);
  });

  it('never prints an unverified channel as ok', () => {
    const out = renderChannels([reading({ actual: null, problem: 'timeout' })]);
    const row = out.text.split(NL).find((l) => l.includes('npm') && !l.startsWith('  npm:'));
    assert.ok(row, 'the channel has a row');
    assert.match(row, /UNVERIFIED/);
    assert.doesNotMatch(row, /^\s+ok\s/);
  });
});

describe('a release in flight is not a release that failed', () => {
  // Found on the first morning this check ran for real. npm publishing here is staged: the tag is
  // pushed, CI builds, and the version then waits for a person to approve it with a passkey. The
  // MCP registry lists only what npm already carries, and its own read view caught up about five
  // minutes after a publish that had already reported success.
  //
  // channels.yml runs on tag push. At that moment npm does not have the release and neither does
  // anything downstream, so every channel would have been called BEHIND on every release - a false
  // alarm at exactly the moment somebody is watching. A check that cries wolf on every release is
  // one people stop reading, which would have cost more than the silence it replaced.
  const gap = (over: Partial<ChannelReading> = {}): ChannelReading =>
    ({ name: 'MCP registry', expected: '0.70.15', actual: '0.70.14', asked: 'GET /x', ...over });

  it('calls a fresh gap waiting, and says how fresh', () => {
    const v = judge(gap({ ageHours: 0.1 }));
    assert.equal(v.verdict, 'waiting');
    assert.match(v.says, /6 minute\(s\) ago/);
    assert.match(v.says, /a problem if it is still true tomorrow/);
  });

  it('reports hours once it is hours', () => {
    assert.match(judge(gap({ ageHours: 3.5 })).says, /3\.5 hour\(s\) ago/);
  });

  it('calls an old gap behind, and says how old', () => {
    // This morning's real case: the release was 15.8 hours old and the registry had never got it.
    const v = judge(gap({ ageHours: 15.8 }));
    assert.equal(v.verdict, 'behind');
    assert.match(v.says, /The release did not reach it/);
    assert.match(v.says, /It has been 16 hour\(s\)/);
  });

  it('treats an unknown age as old, not as fresh', () => {
    // Not knowing how long a channel has been behind is not a reason to assume it just happened.
    assert.equal(judge(gap({ ageHours: null })).verdict, 'behind');
    assert.equal(judge(gap()).verdict, 'behind');
  });

  it('counts waiting apart from behind, and does not call it a failure', () => {
    const out = renderChannels([
      { name: 'npm', expected: '0.70.15', actual: '0.70.15', asked: 'x' },
      gap({ ageHours: 0.2 }),
    ]);
    assert.equal(out.waiting, 1);
    assert.equal(out.behind, 0);
    assert.match(out.text, /have not caught up with this release yet: MCP registry/);
    assert.doesNotMatch(out.text, /did not get this release/);
    assert.doesNotMatch(out.text, /Every channel answered/);
  });

  it('still fails on a gap that has had long enough', () => {
    const out = renderChannels([gap({ ageHours: 48 })]);
    assert.equal(out.behind, 1);
    assert.equal(out.waiting, 0);
  });
});
