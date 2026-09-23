// Phase 13: the message in the team's chat. Two rules decide what it says.
//
// It is short. A chat message that repeats the whole report is scrolled past; this one says how many
// failures there are, what kind they are, and the one or two that need a person, then links to the
// full report.
//
// It stays quiet when nothing needs anyone. A tool that posts every green run is muted within a
// week, and then it is useless on the day it matters.
//
// Settings: TEWIP_SLACK_WEBHOOK, TEWIP_TEAMS_WEBHOOK (incoming webhook URLs). Both may be set.
import type { TriageItem } from '../../outlets/items.ts';

export interface ChatMessage {
  /** The one line a phone notification shows. */
  headline: string;
  /** The body, in the chat's own light markup. */
  lines: string[];
  /** Nothing here needs a person: do not post at all. */
  quiet: boolean;
}

const WORDS: Record<string, string> = {
  REAL_BUG: 'real bug',
  LOCATOR_DRIFT: 'renamed element',
  TIMING: 'flaky',
  ENV: 'environment',
  TEST_DATA: 'test data',
  UNKNOWN: 'not yet known',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The message for a run. `needsPerson` is the gate's blocking list: failures that are not known
 * noise. Everything else is counted but not shouted about.
 */
export function chatMessage(items: TriageItem[], needsPerson: TriageItem[], where: { project: string; branch: string; runUrl: string; reportUrl?: string }): ChatMessage {
  if (items.length === 0) return { headline: 'All tests passed.', lines: [], quiet: true };
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.diagnosis.category, (counts.get(item.diagnosis.category) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => `${n} ${WORDS[category] ?? category.toLowerCase()}`)
    .join(', ');

  const place = [where.project, where.branch].filter(Boolean).join(' · ');
  const headline = needsPerson.length === 0
    ? `${plural(items.length, 'failure')} on ${place || 'this run'}, none needs a person (${breakdown})`
    : `${plural(needsPerson.length, 'failure')} needs a person on ${place || 'this run'} (${breakdown} in total)`;

  const lines: string[] = [];
  for (const item of needsPerson.slice(0, 5)) {
    lines.push(`• *${item.title}* — ${WORDS[item.diagnosis.category] ?? item.diagnosis.category} (${Math.round(item.diagnosis.confidence * 100)}%): ${item.action.summary ?? item.errorHead}`.slice(0, 300));
  }
  if (needsPerson.length > 5) lines.push(`• and ${needsPerson.length - 5} more`);
  if (needsPerson.length === 0) lines.push('Nothing is blocking: every failure is a known flaky test or an environment problem.');
  const links = [where.runUrl ? `<${where.runUrl}|the run>` : '', where.reportUrl ? `<${where.reportUrl}|the full report>` : ''].filter(Boolean);
  if (links.length > 0) lines.push(links.join(' · '));

  return { headline, lines, quiet: needsPerson.length === 0 };
}

/** Slack's incoming-webhook shape: a headline everyone sees, then the detail. */
export function slackPayload(message: ChatMessage): object {
  return {
    text: `Tewip: ${message.headline}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Tewip:* ${message.headline}` } },
      ...(message.lines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: message.lines.join('\n') } }] : []),
    ],
  };
}

/** Teams reads Slack's link syntax as text, so links are rewritten for its own card. */
export function teamsPayload(message: ChatMessage): object {
  const asMarkdown = (line: string) => line.replace(/<([^|>]+)\|([^>]+)>/g, '[$2]($1)').replace(/\*([^*]+)\*/g, '**$1**');
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: `Tewip: ${message.headline}`,
    themeColor: message.quiet ? '2EB67D' : 'E01E5A',
    title: `Tewip: ${asMarkdown(message.headline)}`,
    text: message.lines.map(asMarkdown).join('\n\n'),
  };
}

export interface ChatTargets {
  slack?: string;
  teams?: string;
}

export function chatFromEnv(env: NodeJS.ProcessEnv = process.env): ChatTargets {
  return { slack: env.TEWIP_SLACK_WEBHOOK?.trim() || undefined, teams: env.TEWIP_TEAMS_WEBHOOK?.trim() || undefined };
}

/**
 * Posts to whichever chats are set up. A quiet message is posted only when `always` is asked for,
 * which is what the weekly note uses; a run's message is not posted when nothing needs a person.
 */
export async function postToChat(message: ChatMessage, targets: ChatTargets, { always = false }: { always?: boolean } = {}): Promise<string[]> {
  if (message.quiet && !always) return [];
  const sent: string[] = [];
  const post = async (url: string, payload: object, name: string) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`${name} refused the message (${res.status}): ${(await res.text()).slice(0, 200)}`);
    sent.push(name);
  };
  if (targets.slack) await post(targets.slack, slackPayload(message), 'Slack');
  if (targets.teams) await post(targets.teams, teamsPayload(message), 'Teams');
  return sent;
}
