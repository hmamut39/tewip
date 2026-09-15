// JSONL persistence shared by the reporter, the history script and future layers.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

/** Reads a JSONL file; missing file yields []. Malformed lines are skipped with a warning. */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const rows: T[] = [];
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        console.warn(`[triage] skipping malformed line ${i + 1} in ${file}`);
      }
    });
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
