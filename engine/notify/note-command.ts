// `tewip note`: the weekly quality note, written from the history Tewip already keeps.
//
// No new model calls and no new test runs: every failure in the window was already diagnosed when
// it happened, so the note is a reading of what is already stored. That keeps it free, keeps it
// honest (it cannot re-judge an old failure with today's rules), and makes it something a lead can
// run every Monday without asking anyone for budget.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HistoryIndex } from '../history.ts';
import { buildItems, type TriageItem } from '../../outlets/items.ts';
import { digestView } from '../../outlets/views/digest.ts';
import { qualityView } from '../../outlets/views/quality.ts';
import { datasetFiles, readRunSummaries, readTriageRecords } from '../../reporters/store.ts';
import { chatFromEnv, postToChat, type ChatMessage } from './chat.ts';

export interface NoteCommand {
  root: string;
  /** Which kept project to write about; without it, every project Tewip has history for. */
  name?: string;
  /** How many days back to read. */
  days: number;
  out?: string;
  /** Also post the headline to Slack or Teams. */
  post: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The projects Tewip has kept history for in this folder. */
export function keptProjects(root: string): string[] {
  const dir = join(root, '.tewip', 'history');
  return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, 'triage.jsonl'))) : [];
}

export async function runNote(cmd: NoteCommand): Promise<string> {
  const projects = cmd.name ? [cmd.name] : keptProjects(cmd.root);
  if (projects.length === 0) {
    throw new Error(`no history in ${join(cmd.root, '.tewip', 'history')}. Run \`tewip explain\` or \`tewip report\` on a few runs first: the note is written from what those kept.`);
  }
  const since = new Date(Date.now() - cmd.days * DAY_MS).toISOString();
  const parts: string[] = [`# Tewip quality note`, '', `The last ${cmd.days} days, read from runs Tewip already diagnosed.`, ''];
  let totalFailures = 0;
  let totalRuns = 0;
  const worst: string[] = [];

  for (const name of projects) {
    const history = datasetFiles(join(cmd.root, '.tewip', 'history', name));
    const records = readTriageRecords(history.triage).filter((r) => r.timestamp >= since);
    const runs = readRunSummaries(history.runs).filter((r) => r.startedAt >= since);
    if (records.length === 0 && runs.length === 0) continue;
    totalRuns += runs.length;
    totalFailures += records.length;

    // The diagnoses were made when each failure happened; nothing is judged again here.
    const index = new HistoryIndex(records, runs);
    const items: TriageItem[] = await buildItems(records, index, { dataset: `history: ${name}`, llm: null, reuseStoredDiagnoses: true });
    parts.push(`## ${name}`, '', `${runs.length} run(s), ${records.length} failure(s).`, '');
    if (items.length > 0) {
      parts.push(digestView(items, runs, `history: ${name}`).markdown, '', qualityView(items, `history: ${name}`).markdown, '');
      const top = [...countBy(items).entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) worst.push(`${name}: mostly ${top[0].toLowerCase().replace('_', ' ')} (${top[1]} of ${items.length})`);
    }
  }

  if (totalRuns === 0) throw new Error(`nothing in the last ${cmd.days} days. Try --days 30.`);
  const note = parts.join('\n');
  console.log(note);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${note}\n`, 'utf8');
    console.log(`\nWritten to ${cmd.out}`);
  }

  if (cmd.post) {
    const targets = chatFromEnv();
    const message: ChatMessage = {
      headline: `quality note: ${totalFailures} failure(s) in ${totalRuns} run(s) over ${cmd.days} days`,
      lines: worst.length > 0 ? worst.map((w) => `• ${w}`) : ['Nothing failed in this period.'],
      quiet: false,
    };
    const sent = await postToChat(message, targets, { always: true });
    console.log(sent.length > 0 ? `Told ${sent.join(' and ')}.` : 'No chat is set up (TEWIP_SLACK_WEBHOOK or TEWIP_TEAMS_WEBHOOK).');
  }
  return note;
}

function countBy(items: TriageItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.diagnosis.category, (counts.get(item.diagnosis.category) ?? 0) + 1);
  return counts;
}
