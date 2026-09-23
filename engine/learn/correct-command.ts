// `tewip correct`: the one place a person tells Tewip it was wrong, about anything.
//
// A diagnosis can already be corrected where Tewip posts it in CI. This is the same thing for
// everything else it decides, and on a person's own machine, where most of the disagreeing happens.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CAUSES, type RootCause, type TriageRecord } from '../../reporters/types.ts';
import { datasetFiles, readTriageRecords } from '../../reporters/store.ts';
import { loadCorrections, saveCorrections, type Correction } from '../corrections.ts';
import { errorShape } from '../signature.ts';
import { isVerdictWord, loadVerdicts, saidByAPerson, saveVerdict, verdictHelp, VERDICT_WORDS, type VerdictKind } from './verdicts.ts';

export interface CorrectCommand {
  root: string;
  /** 'flaky' | 'security' | ... or a root cause for a diagnosis. */
  kind: string;
  /** What it is about: a test title, a file:line. */
  key?: string;
  verdict?: string;
  reason?: string;
  /** Show what has been corrected so far instead of adding one. */
  list?: boolean;
  by?: string;
}

const KINDS = Object.keys(VERDICT_WORDS) as VerdictKind[];

/**
 * The failure a title names, and the history folder it lives in. The folder matters: corrections are
 * kept beside the runs of that project, which is where the engine looks for them - an earlier
 * version wrote them one directory up, where nothing ever read them.
 */
function findRecord(root: string, key: string): { record: TriageRecord; historyDir: string } | null {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return null;
  for (const project of readdirSync(dir)) {
    const historyDir = join(dir, project);
    const records = readTriageRecords(datasetFiles(historyDir).triage);
    const found = [...records].reverse().find((r) => r.testId.toLowerCase().includes(key.trim().toLowerCase()));
    if (found) return { record: found, historyDir };
  }
  return null;
}

export function runCorrect(cmd: CorrectCommand): string {
  const who = cmd.by ?? process.env.USER ?? process.env.USERNAME ?? 'someone on the team';

  if (cmd.list) {
    const verdicts = loadVerdicts(cmd.root);
    const historyRoot = join(cmd.root, '.tewip', 'history');
    const diagnoses = (existsSync(historyRoot) ? readdirSync(historyRoot) : []).flatMap((project) => loadCorrections(join(historyRoot, project)));
    if (verdicts.length === 0 && diagnoses.length === 0) return 'Nothing has been corrected yet.\n\n' + verdictHelp();
    const lines = [`${verdicts.length + diagnoses.length} correction(s), newest last:`, ''];
    for (const v of verdicts) lines.push(`  ${v.kind.padEnd(9)} ${v.key} -> ${v.verdict}  (${saidByAPerson(v)})`);
    for (const d of diagnoses) lines.push(`  diagnosis ${d.testId} -> ${d.category}  (${d.by}${d.reason ? `: ${d.reason}` : ''})`);
    return lines.join('\n');
  }

  const kind = cmd.kind?.trim().toLowerCase() ?? '';
  if (!cmd.key || !cmd.verdict) throw new Error(`usage: tewip correct <${[...KINDS, 'diagnosis'].join('|')}> "<what it is about>" <verdict> ["why"]\n\n${verdictHelp()}`);

  // A diagnosis is corrected into the same store the CI path writes, so both ends agree.
  if (kind === 'diagnosis') {
    const category = cmd.verdict.trim().toUpperCase() as RootCause;
    if (!ROOT_CAUSES.includes(category)) throw new Error(`"${cmd.verdict}" is not a category. They are: ${ROOT_CAUSES.join(', ')}`);
    const found = findRecord(cmd.root, cmd.key);
    if (!found) throw new Error(`no failure of a test called "${cmd.key}" is in the history Tewip has kept here. Run \`tewip explain\` on the report first, so there is something to correct.`);
    const { record, historyDir } = found;
    const correction: Correction = {
      schemaVersion: 1,
      testId: record.testId,
      // Stored exactly as the matcher compares it: a truncated shape can never equal a real one.
      errorShape: errorShape(record.errorMessage),
      category,
      by: who,
      at: new Date().toISOString(),
      reason: cmd.reason,
      source: 'tewip correct',
      wasCategory: record.diagnosis?.category,
    };
    saveCorrections(historyDir, [correction]);
    return [
      `Noted: "${record.testId}" is ${category}${record.diagnosis?.category ? `, not ${record.diagnosis.category}` : ''}.`,
      'Tewip will answer with your decision the next time that test fails the same way, and say it was yours.',
    ].join('\n');
  }

  if (!KINDS.includes(kind as VerdictKind)) throw new Error(`"${cmd.kind}" is not something Tewip decides. It decides: ${[...KINDS, 'diagnosis'].join(', ')}.\n\n${verdictHelp()}`);
  const verdictKind = kind as VerdictKind;
  if (!isVerdictWord(verdictKind, cmd.verdict)) {
    throw new Error(`"${cmd.verdict}" is not one of the answers a ${verdictKind} verdict takes. They are: ${VERDICT_WORDS[verdictKind].join(', ')}.`);
  }

  const saved = saveVerdict(cmd.root, { kind: verdictKind, key: cmd.key, verdict: cmd.verdict.trim().toLowerCase(), reason: cmd.reason ?? '', by: who });
  return [
    `Noted: ${verdictKind} "${cmd.key}" is ${saved.verdict}.`,
    'Tewip will say that from now on, and say it was your decision rather than its own.',
    'It will not act on it by itself: a correction changes what it says, never what it does.',
  ].join('\n');
}
