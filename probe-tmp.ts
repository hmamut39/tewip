import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildItems } from './outlets/items.ts';
import { HistoryIndex } from './engine/history.ts';
import { readTriageRecords, readRunSummaries, datasetFiles } from './reporters/store.ts';

// How much of Tewip's work needs no model at all? Rules only, llm: null - exactly what a user
// gets with no API key configured.
let total = 0, decided = 0;
const rows: string[] = [];
for (const d of readdirSync('data/real')) {
  const dir = join('data/real', d);
  if (!existsSync(resolve(dir, 'triage.jsonl'))) continue;
  const files = datasetFiles(dir);
  const records = readTriageRecords(files.triage);
  if (records.length === 0) continue;
  const runs = readRunSummaries(files.runs);
  const items = await buildItems(records, new HistoryIndex(records, runs), { dataset: d, llm: null, reuseStoredDiagnoses: false });
  const answered = items.filter((i) => i.diagnosis.category !== 'UNKNOWN').length;
  total += items.length; decided += answered;
  rows.push(`  ${d.padEnd(22)} ${String(answered).padStart(5)} of ${String(items.length).padStart(5)}  ${((answered / items.length) * 100).toFixed(1)}%`);
}
console.log('Failures answered with no model call, by dataset:');
for (const r of rows) console.log(r);
console.log(`\n  ALL                    ${decided} of ${total}  ${((decided / total) * 100).toFixed(1)}% cost nothing`);
console.log(`  ${total - decided} of ${total} (${(((total - decided) / total) * 100).toFixed(1)}%) are what a model would be asked about.`);
