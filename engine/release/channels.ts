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
}

export type Verdict = 'current' | 'behind' | 'ahead' | 'unverified';

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
  if (order === 0) return { ...reading, verdict: 'current', says: `has ${reading.actual}.` };
  if (order < 0) {
    return { ...reading, verdict: 'behind', says: `has ${reading.actual}, but this repository is at ${reading.expected}. The release did not reach it.` };
  }
  // Ahead is not an error on its own: the editor extension keeps its own version line, and a
  // channel can legitimately carry something this checkout has not caught up with.
  return { ...reading, verdict: 'ahead', says: `has ${reading.actual}, which is newer than this checkout's ${reading.expected}.` };
}

const MARK: Record<Verdict, string> = { current: 'ok', behind: 'BEHIND', ahead: 'ahead', unverified: 'UNVERIFIED' };

/** The whole answer, written so the two states that need a person are impossible to skim past. */
export function renderChannels(readings: ChannelReading[]): { text: string; behind: number; unverified: number } {
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
  if (behind.length === 0 && unverified.length === 0) lines.push('Every channel answered, and every one has this release.', '');

  lines.push('How each was asked:');
  for (const c of judged) lines.push(`  ${c.name}: ${c.asked}`);
  return { text: lines.join(String.fromCharCode(10)), behind: behind.length, unverified: unverified.length };
}
