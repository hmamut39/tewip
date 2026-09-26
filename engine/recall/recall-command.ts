// `tewip recall "<an error, or a question>"`: what this project already concluded.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { datasetFiles, readTriageRecords } from '../../reporters/store.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { loadCorrections, type Correction } from '../corrections.ts';
import { memories, recall, renderRecall } from './recall.ts';

export interface RecallCommand {
  root: string;
  question: string;
  /** Narrow to one test, when the question is about a particular one. */
  testId?: string;
  limit?: number;
  name?: string;
  out?: string;
}

/** Everything kept for this project: its failures, and the times a person overruled Tewip. */
function kept(root: string, only?: string): { records: TriageRecord[]; corrections: Correction[] } {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return { records: [], corrections: [] };
  const records: TriageRecord[] = [];
  const corrections: Correction[] = [];
  for (const project of only ? [only] : readdirSync(dir)) {
    const where = join(dir, project);
    if (!existsSync(where)) continue;
    records.push(...readTriageRecords(datasetFiles(where).triage));
    corrections.push(...loadCorrections(where));
  }
  return { records, corrections };
}

export function runRecall(cmd: RecallCommand): string {
  const { records, corrections } = kept(cmd.root, cmd.name);
  if (records.length === 0) {
    const empty = 'Nothing has been kept here yet, so there is no history to search. Run `tewip explain <report>` first.';
    console.log(empty);
    return empty;
  }
  const found = recall(cmd.question, memories(records, corrections), { testId: cmd.testId, limit: cmd.limit ?? 5 });
  const report = renderRecall(cmd.question, found);
  console.log(report);
  console.error(`\nSearched ${records.length} kept failure(s) and ${corrections.length} correction(s). No model was called.`);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  return report;
}
