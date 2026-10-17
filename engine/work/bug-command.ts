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
import { TEWIP_LABEL } from './jira-command.ts';
import { trackerFromEnv, trackerHelp } from './trackers.ts';

/** Bugs Tewip filed carry this as well, so a second run finds them and does not file again. */
export const BUG_LABEL = 'tewip-bug';

/**
 * How sure Tewip has to be before it puts a person's name on a ticket.
 *
 * Named and exported because of what it collides with. Phase 55 capped a model-only diagnosis at
 * **0.45** - the model is not reliable enough for its word alone to be acted on - and this bar has
 * been 0.8 since Phase 10. The two numbers were set eight weeks apart and never compared, and
 * together they mean **a bug only the model recognised can never be filed**, whatever it says.
 *
 * Measured over 1,964 real failures from five public projects (gutenberg, supabase, lxdui, penpot,
 * jupyterlab) with the rules alone: **20 REAL_BUG verdicts, of which 1 reaches 0.8.** Four of the
 * five projects produce none at all. On a real jest report of a plain value mismatch - "Expected: 4,
 * Received: 3", which is as clear as a real bug gets - the verdict is REAL_BUG at 0.45 from the
 * model, and `bugs` files nothing.
 *
 * The bar is not lowered here. A ticket opened on a model's unsupported word is the thing this
 * project exists not to do, and 0.45 is the honest reading of how often that word is right. What
 * changes is that the refusal now says which of the two reasons applies, because "none of them is a
 * real bug Tewip is confident about" was being printed for twenty failures Tewip had called real
 * bugs.
 */
export const CONFIDENT_ENOUGH = 0.8;

/**
 * Why nothing was filed - the two cases told apart.
 *
 * The old sentence was one line for both: `${items.length} failure(s), and none of them is a real
 * bug Tewip is confident about (${kinds})`, where `kinds` was every category present. On a real
 * report it printed **"none of them is a real bug Tewip is confident about (REAL_BUG, ENV)"** -
 * listing REAL_BUG inside the sentence denying there was one. A reader cannot tell from that whether
 * Tewip found nothing or found something it would not act on, and those call for opposite next steps.
 */
export function whyNothingWasFiled(items: TriageItem[], unsure: TriageItem[]): string {
  const kinds = [...new Set(items.filter((i) => i.diagnosis.category !== 'REAL_BUG').map((i) => i.diagnosis.category))];
  if (unsure.length === 0) {
    return (
      `${items.length} failure(s), and none of them looks like the application being wrong` +
      `${kinds.length > 0 ? ` - they are ${kinds.join(', ')}` : ''}. Nothing was filed, which is the point.`
    );
  }
  const highest = Math.max(...unsure.map((i) => i.diagnosis.confidence));
  const byModel = unsure.filter((i) => /AI|gpt|claude|model/i.test(i.source)).length;
  return [
    `${items.length} failure(s). ${unsure.length} of them Tewip reads as a real bug, and none of those reaches the ${CONFIDENT_ENOUGH.toFixed(2)} confidence it requires before opening a ticket in somebody's name - the highest is ${highest.toFixed(2)}.`,
    byModel > 0
      ? `${byModel === unsure.length ? 'All' : `${byModel}`} of them came from the AI layer, which is capped at 0.45 on purpose: a model's unsupported word is not enough to file on.`
      : '',
    // What a CI user can actually do about it. The rules decline a value mismatch without a stable
    // failing streak, and on one run there is no streak to read - which is not over-caution:
    // measured over 2,767 labelled real failures, a value mismatch is TIMING 90% of the time and a
    // real bug 9% of the time (`node eval/mismatch-precision.ts`). History is what separates them.
    'What would change this: history. The rules will not call a wrong value a bug without a stable failing streak behind it, because a flaky test produces the same wrong value - on real labelled data a value mismatch is a flaky test nine times out of ten. Keep this project\'s runs (`--name <project>`, or let the Action keep them) and the same failure in a second and third run is what the rules read. A person\'s correction on the failure in CI settles it immediately.',
    `Nothing was filed. These are listed in \`tewip explain\` with their evidence${kinds.length > 0 ? `, alongside ${kinds.join(', ')} failures that are deliberately never filed` : ''}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

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
  // Jira, Rally or GitHub Issues - whichever this team uses. A dry run answers the question people
  // ask first ("what would it file?") and needs no account at all; only --create writes.
  const chosen = trackerFromEnv(cmd.projectKey);
  if (cmd.create && !chosen?.tracker.canWrite()) throw new Error(`filing a bug needs a tracker that can be written to; showing what would be filed does not.\n${trackerHelp()}`);
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
  const bugs = items.filter((i) => i.diagnosis.category === 'REAL_BUG' && i.diagnosis.confidence >= CONFIDENT_ENOUGH);
  const unsure = items.filter((i) => i.diagnosis.category === 'REAL_BUG' && i.diagnosis.confidence < CONFIDENT_ENOUGH);
  const lines: string[] = [`Report: ${cmd.report}`, `Project: ${cmd.projectKey}`, ''];
  if (items.length === 0) {
    console.log('Every test in that report passed. Nothing to file.');
    return [];
  }
  if (bugs.length === 0) {
    console.log(whyNothingWasFiled(items, unsure));
    return [];
  }

  const tracker = chosen?.tracker.canWrite() ? chosen.tracker : null;
  let existing: Array<{ key: string; title: string }> = [];
  if (tracker && chosen) {
    lines.push(`Tracker: ${tracker.name}`, '');
    existing = await tracker.mine(chosen.project, BUG_LABEL);
  } else {
    lines.push('No tracker was contacted: this is what would be filed. Set one up (see `tewip bugs` without --create for the settings), then add --create.', '');
  }

  let filed = 0;
  for (const item of bugs.slice(0, cmd.max)) {
    const summary = bugSummary(item);
    const already = existing.find((i) => i.title === summary);
    if (already) {
      lines.push(`  ${item.title}  already filed as ${already.key}`);
      if (cmd.create && tracker) {
        await tracker.comment(already.key, seenAgain(item, facts.runUrl)).catch(() => lines.push(`    (could not add the note to ${already.key})`));
        lines.push(`    added a note that it happened again`);
      }
      continue;
    }
    if (!cmd.create || !tracker || !chosen) {
      lines.push(`  would file: ${summary}`);
      lines.push(`      because: ${item.diagnosis.category} at ${item.diagnosis.confidence.toFixed(2)} - ${item.errorHead.replace(/\s+/g, ' ').slice(0, 100)}`);
      continue;
    }
    const key = await tracker.create(chosen.project, {
      kind: 'bug',
      title: summary,
      body: bugBody(item, facts.runUrl),
      labels: [TEWIP_LABEL, BUG_LABEL, `tewip-${item.component.replace(/[^\w-]+/g, '-')}`.slice(0, 40)],
    });
    lines.push(`  filed ${key}: ${summary}`);
    filed++;
  }

  // `items.length - bugs.length` was described as "flaky tests, environment or test data", which is
  // untrue of a REAL_BUG sitting below the bar: a bug Tewip is 0.45 sure of was being counted, in
  // print, as a flaky test. And the `max` cap was silent - the same mistake `prove` made in Phase 58,
  // where a sampled answer read as a whole one.
  const notBugs = items.length - bugs.length - unsure.length;
  const beyondCap = Math.max(0, bugs.length - cmd.max);
  lines.push(
    '',
    `${bugs.length} of ${items.length} failure(s) look like real bugs.` +
      (notBugs > 0 ? ` ${notBugs} were flaky tests, environment or test data and were deliberately not filed.` : '') +
      (unsure.length > 0 ? ` ${unsure.length} more look like real bugs but below the ${CONFIDENT_ENOUGH.toFixed(2)} confidence needed to file one, so they were not.` : ''),
  );
  if (beyondCap > 0) lines.push(`${beyondCap} were past the --max ${cmd.max} limit and were not looked at. Raise it with \`--max ${bugs.length}\`.`);
  lines.push(cmd.create ? `${filed} ticket(s) created in ${tracker?.name}. Tewip never moves, assigns or closes one.` : 'Nothing was created. Add --create to file them.');
  console.log(lines.join('\n'));
  return bugs;
}
