// Is every place Tewip is published actually carrying this release?
//
// There is a standing rule on this project: check every distribution channel after every
// improvement, because a stale channel looks exactly like a current one. It was being done by hand,
// and by hand it failed twice in one day - not because the check was skipped, but because the
// question was wrong. The MCP registry was asked `?search=<name>&limit=100`, which returns a capped
// version history and came back without the two newest releases in it. It answered with a version
// number, the version number looked plausible, and it would have looked just as plausible if
// nothing were wrong.
//
// So the verdict here has three values, not two. `unverified` is the whole point of the file: a
// channel nobody could read is not a channel that is up to date, and must never be rendered as one.

/** What a channel is expected to carry, and what it said. */
export interface ChannelReading {
  name: string;
  /** The version this repository says the channel should have. */
  expected: string;
  /** What the channel answered, or null when it could not be read. */
  actual: string | null;
  /** Why it could not be read. Present only when `actual` is null. */
  problem?: string;
  /** The query used, so a wrong question is visible in the output rather than invisible in a file. */
  asked: string;
  /**
   * How long this repository has been at `expected`, in hours, when that is known.
   *
   * A channel is not late the moment a release is cut. npm publishing here is staged: a tag is
   * pushed, the build runs, and the version then waits for a person to approve it with a passkey,
   * which can be hours. The MCP registry only lists what npm already carries, and its own read view
   * caught up about five minutes after a publish that had already reported success. Reported as
   * `behind` on a tag push - which is when this check runs - every one of those would be a false
   * alarm at exactly the moment somebody is watching, and a check that cries wolf on every release
   * is one people stop reading.
   *
   * So a gap is `waiting` while it is young and `behind` once it is not. What makes it honest is
   * that `waiting` still says how long it has been waiting: a release that silently never went out
   * reads as "waiting 38 hours", which is a sentence nobody can mistake for fine.
   */
  ageHours?: number | null;
  /**
   * Files that make up this channel's published artifact and have changed since its current
   * version was set - so the channel carries the right version number and the wrong content.
   *
   * The editor extension keeps its own version line, bumped only when the extension itself
   * changes, and the marketplaces render its README on the listing page. Phase 114 corrected a
   * line of that README; the version did not move, because the extension's code did not. This
   * check then reported "ok - Open VSX has 0.13.0", which was true, while both listings went on
   * showing the old sentence. The standing rule on this project is that a stale channel looks
   * exactly like a current one, and here the check itself was the thing that made it look current.
   *
   * An empty array means nothing changed. `undefined` with `contentProblem` set means nobody
   * could tell, which is not the same thing and is never rendered as if it were.
   */
  changedSince?: string[];
  /** Why the content comparison could not be made. */
  contentProblem?: string;
}

/** A gap younger than this is a release in flight, not a release that failed. */
export const PATIENCE_HOURS = 12;

export type Verdict = 'current' | 'behind' | 'waiting' | 'ahead' | 'unverified' | 'stale-content';

export interface ChannelVerdict extends ChannelReading {
  verdict: Verdict;
  /** One sentence a person can act on. */
  says: string;
}

/** Compares two dotted versions. Missing parts count as zero, so 0.70 is older than 0.70.1. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function judge(reading: ChannelReading): ChannelVerdict {
  if (reading.actual === null) {
    return {
      ...reading,
      verdict: 'unverified',
      says: `could not be read${reading.problem ? `: ${reading.problem}` : ''}. This is not the same as being up to date - nothing here says whether ${reading.name} has ${reading.expected} or not.`,
    };
  }
  const order = compareVersions(reading.actual, reading.expected);
  if (order === 0) {
    // The version matching is not the same as the content matching, and this is the only place
    // where a channel can be wrong while every number agrees.
    const changed = reading.changedSince ?? [];
    if (changed.length > 0) {
      const some = changed.slice(0, 4).join(', ');
      const rest = changed.length > 4 ? `, and ${changed.length - 4} more` : '';
      return {
        ...reading,
        verdict: 'stale-content',
        says: `has ${reading.actual}, which is the version this repository expects - but ${changed.length} file(s) changed since that version was set (${some}${rest}), so what is published is not what is here.`,
      };
    }
    const caveat = reading.contentProblem ? ` Whether its files changed since could not be checked: ${reading.contentProblem}.` : '';
    return { ...reading, verdict: 'current', says: `has ${reading.actual}.${caveat}` };
  }
  if (order < 0) {
    const age = reading.ageHours;
    // Unknown age is treated as old. Not knowing how long a channel has been behind is not a reason
    // to assume it only just happened.
    if (age !== null && age !== undefined && age < PATIENCE_HOURS) {
      const how = age < 1 ? `${Math.max(1, Math.round(age * 60))} minute(s)` : `${age.toFixed(1)} hour(s)`;
      return {
        ...reading,
        verdict: 'waiting',
        says: `has ${reading.actual}; ${reading.expected} was cut ${how} ago and has not reached it yet. Normal this soon after a release - a problem if it is still true tomorrow.`,
      };
    }
    const how = age === null || age === undefined ? '' : ` It has been ${age.toFixed(0)} hour(s).`;
    return { ...reading, verdict: 'behind', says: `has ${reading.actual}, but this repository is at ${reading.expected}. The release did not reach it.${how}` };
  }
  // Ahead is not an error on its own: the editor extension keeps its own version line, and a
  // channel can legitimately carry something this checkout has not caught up with.
  return { ...reading, verdict: 'ahead', says: `has ${reading.actual}, which is newer than this checkout's ${reading.expected}.` };
}

const MARK: Record<Verdict, string> = {
  current: 'ok',
  behind: 'BEHIND',
  waiting: 'waiting',
  ahead: 'ahead',
  unverified: 'UNVERIFIED',
  'stale-content': 'STALE',
};

/** The whole answer, written so the states that need a person are impossible to skim past. */
export function renderChannels(readings: ChannelReading[]): { text: string; behind: number; unverified: number; waiting: number; stale: number } {
  const judged = readings.map(judge);
  const width = Math.max(...judged.map((c) => c.name.length), 12);
  const lines = ['Where Tewip is published', ''];
  for (const c of judged) lines.push(`  ${MARK[c.verdict].padEnd(11)} ${c.name.padEnd(width)}  ${c.says}`);

  const behind = judged.filter((c) => c.verdict === 'behind');
  const unverified = judged.filter((c) => c.verdict === 'unverified');
  lines.push('');
  if (behind.length > 0) {
    lines.push(`${behind.length} channel(s) did not get this release: ${behind.map((c) => c.name).join(', ')}.`, '');
  }
  if (unverified.length > 0) {
    // Named separately from `behind` on purpose. Folding the two together is how an unanswered
    // query becomes a clean report.
    lines.push(`${unverified.length} channel(s) could not be checked at all: ${unverified.map((c) => c.name).join(', ')}. Nothing above says whether those are current.`, '');
  }
  const waiting = judged.filter((c) => c.verdict === 'waiting');
  if (waiting.length > 0) {
    lines.push(`${waiting.length} channel(s) have not caught up with this release yet: ${waiting.map((c) => c.name).join(', ')}. Nothing is wrong unless this is still true tomorrow.`, '');
  }
  const stale = judged.filter((c) => c.verdict === 'stale-content');
  if (stale.length > 0) {
    lines.push(
      `${stale.length} channel(s) carry the right version and the wrong content: ${stale.map((c) => c.name).join(', ')}. Their published files were built before those changes, so what people read there is out of date. Bump the version and release to fix it.`,
      '',
    );
  }
  const unchecked = judged.filter((c) => c.verdict === 'current' && c.contentProblem);
  if (unchecked.length > 0) {
    lines.push(`${unchecked.length} channel(s) are on the right version, but whether their content is current could not be checked: ${unchecked.map((c) => c.name).join(', ')}.`, '');
  }
  if (behind.length === 0 && unverified.length === 0 && waiting.length === 0 && stale.length === 0) {
    lines.push('Every channel answered, and every one has this release.', '');
  }

  lines.push('How each was asked:');
  for (const c of judged) lines.push(`  ${c.name}: ${c.asked}`);
  return { text: lines.join(String.fromCharCode(10)), behind: behind.length, unverified: unverified.length, waiting: waiting.length, stale: stale.length };
}
