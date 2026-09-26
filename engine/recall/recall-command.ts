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

/**
 * The report, without printing it. An MCP server speaks JSON-RPC over stdout, so anything one of
 * its tools calls has to return its answer: a stray console.log corrupts every response the
 * assistant receives, and the corruption looks like the tool being broken rather than noisy.
 */
export function recallReport(cmd: RecallCommand): { report: string; searched: number; corrections: number } {
  const { records, corrections } = kept(cmd.root, cmd.name);
  if (records.length === 0) {
    return { report: 'Nothing has been kept here yet, so there is no history to search. Run `tewip explain <report>` first.', searched: 0, corrections: 0 };
  }
  const found = recall(cmd.question, memories(records, corrections), { testId: cmd.testId, limit: cmd.limit ?? 5 });
  return { report: renderRecall(cmd.question, found), searched: records.length, corrections: corrections.length };
}

export function runRecall(cmd: RecallCommand): string {
  const { report, searched, corrections } = recallReport(cmd);
  console.log(report);
  if (searched > 0) console.error(`\nSearched ${searched} kept failure(s) and ${corrections} correction(s). No model was called.`);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  return report;
}
