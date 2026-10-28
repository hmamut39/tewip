// How much of what `recall` counted was the same failure written down twice?
//
// Playwright writes every retry of a failing test as its own record. Nothing downstream knew that,
// so a question asked of a real history got an answer in which one event was counted three times:
// "5 earlier failure(s) look like this one", four of them the same test, three the same run on the
// same day. The footer agreed with the body - "Searched 1053 diagnosed failure(s)" - for a project
// holding 596 distinct ones.
//
// This re-derives the two numbers rather than trusting the ones in the commit message. For each
// kept history: how many records are there, how many distinct failures (one run, one test, one
// error shape), and what share of the pile was duplication. Nothing here is a judgement call, so
// nothing here needs a hand label - which is why it can run over every dataset at once.
//
// It also asks each history one question it should answer and one it should refuse, because a
// count being right is no use if the retrieval around it is deaf or credulous.
//
// Usage: node eval/recall-counting.ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readTriageRecords } from '../reporters/store.ts';
import { errorShape } from '../engine/signature.ts';
import { recallReport } from '../engine/recall/recall-command.ts';
import { join } from 'node:path';
import { mkdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DATASETS = [
  'data/real/gutenberg',
  'data/real/gutenberg-holdout',
  'data/real/gutenberg-fresh',
  'data/real/gutenberg-aug',
  'data/real/gutenberg-aug2',
  'data/real/supabase',
];

/** A question with nothing to do with any test suite. Every history should decline it. */
const NONSENSE = 'the VAT column on the quarterly invoice PDF is rounded down';

/** `recall` reads a project's own `.tewip/history`, so a dataset has to be staged as one. */
function asProject(dataDir: string): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-recall-eval-'));
  const where = join(root, '.tewip', 'history', 'ds');
  mkdirSync(where, { recursive: true });
  for (const file of ['triage.jsonl', 'runs.jsonl']) {
    const from = resolve(dataDir, file);
    if (existsSync(from)) copyFileSync(from, join(where, file));
  }
  return root;
}

console.log('');
console.log('# What recall counts, and what it declines to answer');
console.log('');
console.log('  dataset                 records  failures  duplication  searched  asked-its-own  asked-nonsense');

let records = 0;
let failures = 0;
const complaints: string[] = [];

for (const dataDir of DATASETS) {
  if (!existsSync(resolve(dataDir))) continue;
  const kept = readTriageRecords(resolve(dataDir, 'triage.jsonl'));
  if (kept.length === 0) continue;
  const distinct = new Set(
    kept.map((r) => `${r.runId}::${r.testId}::${errorShape((r.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 4000))}`),
  ).size;
  records += kept.length;
  failures += distinct;

  // The most-repeated error in this history is the one a person is most likely to ask about.
  const tally = new Map<string, number>();
  for (const r of kept) tally.set(r.errorMessage ?? '', (tally.get(r.errorMessage ?? '') ?? 0) + 1);
  const commonest = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const root = asProject(dataDir);
  const own = await recallReport({ root, question: commonest.slice(0, 400), name: 'ds' });
  const none = await recallReport({ root, question: NONSENSE, name: 'ds' });

  const answered = /look like this one/.test(own.report);
  const declined = /resembles it/.test(none.report);
  const share = `${Math.round(((kept.length - distinct) / kept.length) * 100)}%`;
  console.log(
    `  ${dataDir.replace('data/real/', '').padEnd(22)} ${String(kept.length).padStart(7)} ${String(distinct).padStart(9)} ${share.padStart(12)} ${String(own.searched).padStart(9)} ${(answered ? 'found' : 'MISSED').padStart(14)} ${(declined ? 'declined' : 'ANSWERED').padStart(15)}`,
  );

  if (own.searched !== distinct) {
    complaints.push(`  ${dataDir}: recall says it searched ${own.searched}, but the history holds ${distinct} distinct failures`);
  }
  if (!answered) {
    complaints.push(`  ${dataDir}: asked about its own commonest error, recall found nothing`);
  }
  if (!declined) {
    complaints.push(`  ${dataDir}: asked about an invoice PDF, recall claimed to recognise it`);
  }
}

console.log('');
console.log(`Across every kept history: ${records} records describe ${failures} distinct failures.`);
console.log(`${records - failures} of them (${Math.round(((records - failures) / Math.max(records, 1)) * 100)}%) are retries of a failure already counted.`);
console.log('');
if (complaints.length > 0) {
  console.log('## Wrong');
  console.log('');
  for (const line of complaints) console.log(line);
  process.exit(1);
}
console.log('Every history reports the number it actually searched, answers a question about itself,');
console.log('and declines one about something it has never seen.');
