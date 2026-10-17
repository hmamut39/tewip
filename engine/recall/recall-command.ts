// `tewip recall "<an error, or a question>"`: what this project already concluded.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildItems } from '../../outlets/items.ts';
import { datasetFiles, readRunSummaries, readTriageRecords } from '../../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { loadCorrections, type Correction } from '../corrections.ts';
import { HistoryIndex } from '../history.ts';
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
function kept(root: string, only?: string): { records: TriageRecord[]; runs: RunSummary[]; corrections: Correction[] } {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return { records: [], runs: [], corrections: [] };
  const records: TriageRecord[] = [];
  const runs: RunSummary[] = [];
  const corrections: Correction[] = [];
  for (const project of only ? [only] : readdirSync(dir)) {
    const where = join(dir, project);
    if (!existsSync(where)) continue;
    const files = datasetFiles(where);
    records.push(...readTriageRecords(files.triage));
    runs.push(...readRunSummaries(files.runs));
    corrections.push(...loadCorrections(where));
  }
  return { records, runs, corrections };
}

/**
 * The kept failures with a category on each, diagnosing the ones that do not have one stored.
 *
 * This is the whole bug Phase 59 was looking for. `memories()` keeps only records that carry a
 * `diagnosis`, and **nothing on the collection path writes one**: the reporter and the harvest both
 * store the raw failure, and the category is worked out when a report is rendered. So on a real
 * 1,305-failure history, `recall` had nothing to search - and said "Nothing in this project's
 * history resembles it... this is new here", footed by "Searched 1305 kept failure(s)". Both halves
 * false: nothing was searched, and 660 of those 1,305 failures were the timeout being asked about.
 *
 * `note`, `flaky` and the risk digest had all been diagnosing on read for months. Recall was the
 * one retrieval layer that demanded a field nobody writes, which made it permanently empty on every
 * project that had not been through `tewip explain` - and empty in a way that read like an answer.
 *
 * Rules only, never a model: `recall`'s promise is no model, no network, nothing to set up, and a
 * question asked of local history must not start costing money because of how it is indexed.
 */
async function diagnosed(records: TriageRecord[], runs: RunSummary[], corrections: Correction[]): Promise<TriageRecord[]> {
  if (records.length === 0) return [];
  const items = await buildItems(records, new HistoryIndex(records, runs), { dataset: 'recall', llm: null, reuseStoredDiagnoses: true, corrections });
  const byCase = new Map(items.map((item) => [`${item.runId}::${item.testId}`, item.diagnosis]));
  return records.map((record) => (record.diagnosis ? record : { ...record, diagnosis: byCase.get(`${record.runId}::${record.testId}`) }) as TriageRecord);
}

/**
 * The report, without printing it. An MCP server speaks JSON-RPC over stdout, so anything one of
 * its tools calls has to return its answer: a stray console.log corrupts every response the
 * assistant receives, and the corruption looks like the tool being broken rather than noisy.
 */
export async function recallReport(cmd: RecallCommand): Promise<{ report: string; searched: number; corrections: number }> {
  const { records, runs, corrections } = kept(cmd.root, cmd.name);
  if (records.length === 0) {
    return { report: 'Nothing has been kept here yet, so there is no history to search. Run `tewip explain <report>` first.', searched: 0, corrections: 0 };
  }

  // The count reported is the count searched. It used to be `records.length` whatever `memories`
  // actually indexed, which is how an empty index came to be described as 1,305 failures searched.
  const mem = memories(await diagnosed(records, runs, corrections), corrections);
  if (mem.length === 0) {
    return {
      report: `${records.length} failure(s) are kept here, but none of them could be given a category, so there is nothing to compare this against. Recall searches what Tewip concluded about a failure, and a failure it cannot read is not a conclusion.`,
      searched: 0,
      corrections: corrections.length,
    };
  }
  const found = recall(cmd.question, mem, { testId: cmd.testId, limit: cmd.limit ?? 5 });
  return { report: renderRecall(cmd.question, found, mem.length), searched: mem.length, corrections: corrections.length };
}

export async function runRecall(cmd: RecallCommand): Promise<string> {
  const { report, searched, corrections } = await recallReport(cmd);
  console.log(report);
  if (searched > 0) console.error(`\nSearched ${searched} diagnosed failure(s) and ${corrections} correction(s). No model was called.`);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  return report;
}
