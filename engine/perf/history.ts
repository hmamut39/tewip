// Phase 30: the stored baseline.
//
// Recording is deliberately **not** automatic, and that is the most important decision in this
// file. A tool that files every run it sees into the baseline ratchets: today's regression becomes
// tomorrow's normal, the comparison keeps saying "within range", and a service gets three times
// slower over a quarter without one report ever being wrong. Tewip records only when asked, so the
// intended use is `--record` on the main branch and a plain comparison everywhere else.
//
// The file is JSON Lines so that a run can be appended without reading or rewriting what is already
// there, and so a person can read it or delete a bad line with an editor.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PerfRun } from './k6.ts';

export interface StoredRun {
  at: string;
  /** Which suite this is, so two different load tests do not become each other's baseline. */
  label: string;
  gitSha?: string;
  /** Metric name to its p95 and median, which is all a comparison needs. */
  timings: Record<string, { p95: number; med: number; avg: number }>;
  requests: number;
}

const file = (root: string): string => join(root, '.tewip', 'perf', 'runs.jsonl');

/** Everything recorded for this label, oldest first. */
export function storedRuns(root: string, label: string): StoredRun[] {
  const path = file(root);
  if (!existsSync(path)) return [];
  const out: StoredRun[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as StoredRun;
      // A line Tewip cannot read is skipped rather than throwing: one bad line written by a crashed
      // run must not make the whole baseline unreadable.
      if (parsed && typeof parsed.at === 'string' && parsed.label === label && parsed.timings) out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

export function recordRun(root: string, label: string, run: PerfRun, requests: number, gitSha?: string): StoredRun {
  const stored: StoredRun = {
    at: run.at,
    label,
    ...(gitSha ? { gitSha } : {}),
    timings: Object.fromEntries(Object.entries(run.timings).map(([m, v]) => [m, { p95: v.p95, med: v.med, avg: v.avg }])),
    requests,
  };
  const path = file(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(stored)}\n`, 'utf8');
  return stored;
}

/** Every stored p95 for one metric, oldest first, for the comparison to read the spread from. */
export function baselineFor(runs: StoredRun[], metric: string): number[] {
  return runs.map((r) => r.timings[metric]?.p95).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** The labels this project has recorded, so a typo in --label does not look like an empty history. */
export function knownLabels(root: string): string[] {
  const path = file(root);
  if (!existsSync(path)) return [];
  const labels = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as StoredRun;
      if (typeof parsed?.label === 'string') labels.add(parsed.label);
    } catch {
      continue;
    }
  }
  return [...labels].sort();
}
