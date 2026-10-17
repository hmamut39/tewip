// JSONL persistence shared by the reporter, the history script and future layers.
import { openSync, readSync, closeSync, fstatSync, appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RunSummary, TriageRecord } from './types.ts';

export const PROJECT_ROOT = join(import.meta.dirname, '..');
export const DATA_DIR = join(PROJECT_ROOT, 'data');
/** Where the reporter collects failures. TRIAGE_DATA_DIR redirects it (e.g. the drift lab uses data/lab). */
const COLLECT_DIR = process.env.TRIAGE_DATA_DIR ? resolve(PROJECT_ROOT, process.env.TRIAGE_DATA_DIR) : DATA_DIR;
export const TRIAGE_FILE = join(COLLECT_DIR, 'triage.jsonl');
export const RUNS_FILE = join(COLLECT_DIR, 'runs.jsonl');

export function appendJsonl(file: string, rows: readonly unknown[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

/**
 * Reads a JSONL file; missing file yields []. Malformed lines are skipped with a warning.
 *
 * Read in chunks rather than whole. `readFileSync(file, 'utf8')` builds one string, and a string in
 * Node cannot exceed 0x1fffffe8 characters - about 512MB. These files only ever grow: the weekly
 * shadow run appends every CI failure it harvests from a public project and keeps the lot, so that
 * accuracy is measured against everything ever collected rather than one week of it. gutenberg's
 * dataset crossed the limit and **every run since has died on this line**, for weeks, while the
 * workflow's only symptom was a red tick nobody was looking at.
 *
 * A UTF-8 character can straddle a chunk boundary, so the last partial line is carried into the next
 * read rather than decoded on its own - decoding a split character gives U+FFFD and a line that no
 * longer parses.
 */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const rows: T[] = [];
  const handle = openSync(file, 'r');
  try {
    const size = fstatSync(handle).size;
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let carry = Buffer.alloc(0);
    let line = 0;
    let offset = 0;
    while (offset < size) {
      const read = readSync(handle, buffer, 0, buffer.length, offset);
      if (read <= 0) break;
      offset += read;
      const chunk = Buffer.concat([carry, buffer.subarray(0, read)]);
      let from = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== 0x0a) continue;
        const text = chunk.subarray(from, i).toString('utf8').replace(/\r$/, '');
        from = i + 1;
        line += 1;
        if (!text.trim()) continue;
        try {
          rows.push(JSON.parse(text) as T);
        } catch {
          console.warn(`[triage] skipping malformed line ${line} in ${file}`);
        }
      }
      carry = chunk.subarray(from);
    }
    const last = carry.toString('utf8').replace(/\r$/, '');
    if (last.trim()) {
      try {
        rows.push(JSON.parse(last) as T);
      } catch {
        console.warn(`[triage] skipping malformed line ${line + 1} in ${file}`);
      }
    }
  } finally {
    closeSync(handle);
  }
  return rows;
}

export const readTriageRecords = (file = TRIAGE_FILE) => readJsonl<TriageRecord>(file);
export const readRunSummaries = (file = RUNS_FILE) => readJsonl<RunSummary>(file);

/**
 * The triage/runs files of a dataset directory. The default dataset is data/ (what the
 * reporter collects); imported datasets live elsewhere, e.g. data/real/<source>/.
 */
export function datasetFiles(dir?: string): { dir: string; triage: string; runs: string } {
  if (!dir) return { dir: DATA_DIR, triage: TRIAGE_FILE, runs: RUNS_FILE };
  const abs = isAbsolute(dir) ? dir : join(PROJECT_ROOT, dir);
  return { dir: abs, triage: join(abs, 'triage.jsonl'), runs: join(abs, 'runs.jsonl') };
}
