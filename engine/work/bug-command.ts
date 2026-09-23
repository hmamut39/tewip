// Phase 10, the third direction: a failure that really is a bug becomes a bug ticket, with the
// evidence that makes it one. A failure that is a flaky test or a broken environment does not -
// that is the whole point. Filing everything is what people already do, and it is why nobody reads
// the tickets.
//
// The same restraint as the rest: nothing is created without --create, the same failure is never
// filed twice (a second sighting is a comment on the ticket Tewip itself opened), and no ticket is
// ever moved, assigned or closed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadCorrections } from '../corrections.ts';
import { HistoryIndex } from '../history.ts';
import { importJunit } from '../import/junit.ts';
import { importBlobReportDir } from '../import/blob.ts';
import { llmFromEnv } from '../llm/client.ts';
import { buildItems, type TriageItem } from '../../outlets/items.ts';
import { ciFacts } from '../ci/platform.ts';
import { Jira, jiraFromEnv, jiraHelp } from './jira.ts';
import { TEWIP_LABEL } from './jira-command.ts';

/** Bugs Tewip filed carry this as well, so a second run finds them and does not file again. */
export const BUG_LABEL = 'tewip-bug';

export interface BugCommand {
  root: string;
  report: string;
  projectKey: string;
  /** Without this, nothing is created: the command only shows what it would file. */
  create: boolean;
  /** How many bugs to file in one run, so a broken build never floods a backlog. */
  max: number;
}

const isBlobDir = (path: string): boolean => statSync(path).isDirectory() && readdirSync(path).some((f) => /^report.*\.zip$/.test(f));

/** The bug report a developer actually wants: what failed, what it did, and why Tewip believes it. */
export function bugBody(item: TriageItem, runUrl: string): string {
  return [
    `The test "${item.title}" failed, and Tewip diagnosed a real bug in the application rather than a problem with the test.`,
    '',
    `Test: ${item.testId}`,
    `File: ${item.file}`,
    item.commit ? `Commit: ${item.commit}` : '',
    runUrl ? `Run: ${runUrl}` : '',
    '',
    'What the test saw:',
    item.errorHead,
    '',
    `Diagnosis: ${item.diagnosis.category} at ${item.diagnosis.confidence.toFixed(2)} confidence (${item.source}).`,
    '',
    'Evidence:',
    ...item.evidence.slice(0, 6).map((line) => `- ${line}`),
    '',
    `Suggested next step: ${item.action.summary}`,
    '',
    'Filed by Tewip because this failure looks like the application being wrong, not the test. If it',
    'is not, say so on the failure in CI (/triage CATEGORY #n reason) and Tewip will answer with your',
    'decision next time instead of its own.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** A short line for a ticket that already exists: the same bug, seen again. */
export const seenAgain = (item: TriageItem, runUrl: string): string =>
  `Seen again: "${item.title}" failed in ${runUrl || 'another run'}${item.commit ? ` on ${item.commit.slice(0, 8)}` : ''}. Tewip still reads it as a real bug (${item.diagnosis.confidence.toFixed(2)}).`;

/**
 * A title that stays the same across runs, so the same failure is recognised next time. The area is
 * added only when it says something the title does not: "checkout (checkout)" helps nobody.
 */
export function bugSummary(item: TriageItem): string {
  const where = (item.component || item.file || '').trim();
  const same = !where || item.title.toLowerCase().includes(where.toLowerCase());
  return (same ? item.title : `${item.title} (${where})`).replace(/\s+/g, ' ').slice(0, 250);
}

export async function runBugs(cmd: BugCommand): Promise<TriageItem[]> {
  const config = jiraFromEnv();
  // A dry run answers the question people ask first - "what would it file?" - and needs no account
  // at all. Only --create talks to Jira.
  if (cmd.create && !config?.token) throw new Error(`filing a bug needs a token: showing what would be filed does not.\n${jiraHelp()}`);
  const path = resolve(cmd.report);
  if (!existsSync(path)) throw new Error(`no such report: ${cmd.report}`);

  const facts = ciFacts();
  const name = basename(statSync(path).isDirectory() ? path : dirname(path)).replace(/[^\w.-]+/g, '-');
  const historyDir = join(cmd.root, '.tewip', 'history', name);
  const meta = { runId: facts.runId || `local-${Date.now()}`, gitSha: facts.sha, workspace: cmd.root };
  const imported = isBlobDir(path) ? importBlobReportDir(path, meta, join(historyDir, 'files')) : importJunit(path, meta);
  const index = new HistoryIndex(imported.records, [imported.summary]);
  const items = await buildItems(imported.records, index, { dataset: `local: ${name}`, llm: llmFromEnv(), corrections: loadCorrections(historyDir) });

  // Only what Tewip itself calls a bug, and only when it is confident enough to put a person's name
  // on it. Everything else is deliberately left out.
  const bugs = items.filter((i) => i.diagnosis.category === 'REAL_BUG' && i.diagnosis.confidence >= 0.8);
  const lines: string[] = [`Report: ${cmd.report}`, `Project: ${cmd.projectKey}`, ''];
  if (items.length === 0) {
    console.log('Every test in that report passed. Nothing to file.');
    return [];
  }
  if (bugs.length === 0) {
    const kinds = [...new Set(items.map((i) => i.diagnosis.category))].join(', ');
    console.log(`${items.length} failure(s), and none of them is a real bug Tewip is confident about (${kinds}). Nothing was filed, which is the point.`);
    return [];
  }

  const jira = config?.token ? new Jira(config) : null;
  let type = 'Bug';
  let existing: Array<{ key: string; summary: string }> = [];
  if (jira) {
    const types = await jira.issueTypes(cmd.projectKey);
    type = ['Bug', 'Defect', 'Task'].find((t) => types.includes(t)) ?? types[0];
    if (!type) throw new Error(`no issue type available in ${cmd.projectKey}`);
    existing = await jira.findByLabel(cmd.projectKey, BUG_LABEL);
  } else {
    lines.push('Jira was not contacted: this is what would be filed. Set TEWIP_JIRA_URL, TEWIP_JIRA_EMAIL and TEWIP_JIRA_TOKEN, then add --create.', '');
  }

  let filed = 0;
  for (const item of bugs.slice(0, cmd.max)) {
    const summary = bugSummary(item);
    const already = existing.find((i) => i.summary === summary);
    if (already) {
      lines.push(`  ${item.title}  already filed as ${already.key}`);
      if (cmd.create && jira) {
        await jira.comment(already.key, seenAgain(item, facts.runUrl)).catch(() => lines.push(`    (could not add the note to ${already.key})`));
        lines.push(`    added a note that it happened again`);
      }
      continue;
    }
    if (!cmd.create || !jira) {
      lines.push(`  would file: ${summary}`);
      lines.push(`      because: ${item.diagnosis.category} at ${item.diagnosis.confidence.toFixed(2)} - ${item.errorHead.replace(/\s+/g, ' ').slice(0, 100)}`);
      continue;
    }
    const key = await jira.createIssue({
      projectKey: cmd.projectKey,
      type,
      summary,
      description: bugBody(item, facts.runUrl),
      labels: [TEWIP_LABEL, BUG_LABEL, `tewip-${item.component.replace(/[^\w-]+/g, '-')}`.slice(0, 40)],
    });
    lines.push(`  filed ${key}: ${summary}`);
    filed++;
  }

  const left = items.length - bugs.length;
  lines.push('', `${bugs.length} of ${items.length} failure(s) look like real bugs; ${left} were flaky tests, environment or test data and were deliberately not filed.`);
  lines.push(cmd.create ? `${filed} ticket(s) created. Tewip never moves, assigns or closes one.` : 'Nothing was created. Add --create to file them.');
  console.log(lines.join('\n'));
  return bugs;
}
