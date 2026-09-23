// `tewip learn`: what the team's corrections add up to, and what to change because of them.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { datasetFiles, readTriageRecords } from '../../reporters/store.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { loadCorrections, type Correction } from '../corrections.ts';
import { loadVerdicts } from './verdicts.ts';
import { asLabels, renderLearning, whatWeLearned } from './learn.ts';

export interface LearnCommand {
  root: string;
  /** Only this kept project. */
  name?: string;
  /** Write the corrections out as labelled examples, for measuring a rule change against them. */
  labels?: string;
  out?: string;
}

/** Everything the team has corrected, and the runs those corrections were made on. */
function gather(root: string, only?: string): { corrections: Correction[]; records: TriageRecord[] } {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return { corrections: [], records: [] };
  const projects = only ? [only] : readdirSync(dir);
  const corrections: Correction[] = [];
  const records: TriageRecord[] = [];
  for (const project of projects) {
    const where = join(dir, project);
    if (!existsSync(where)) continue;
    corrections.push(...loadCorrections(where));
    records.push(...readTriageRecords(datasetFiles(where).triage));
  }
  return { corrections, records };
}

export function runLearn(cmd: LearnCommand): string {
  const { corrections, records } = gather(cmd.root, cmd.name);
  const learned = whatWeLearned(corrections, loadVerdicts(cmd.root), records);
  const report = renderLearning(learned);
  console.log(report);

  if (cmd.labels) {
    const path = resolve(cmd.labels);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${asLabels(corrections)}\n`, 'utf8');
    console.log(`\n${corrections.length} labelled example(s) written to ${cmd.labels}. They are the real answers to real failures of yours: keep them, and any change to the rules can be measured against them rather than argued about.`);
  }
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
    console.log(`\nWritten to ${cmd.out}`);
  }
  return report;
}
