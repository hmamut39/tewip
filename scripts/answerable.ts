// Phase 56: is this task answerable at all from what exists when the test fails?
//
// Phase 55 measured the model layer at 17.8% against 752 real labelled CI failures, where answering
// "TIMING" to everything would have scored about 70%. The obvious conclusion is that the model is
// bad. The less comfortable possibility is that the evidence available at failure time does not
// contain the answer, and that any classifier would do about as badly.
//
// That is a measurable question, not a matter of opinion. For each signal a classifier could
// actually see at the moment of failure, this asks how much the label changes when the signal
// changes. A signal that is distributed identically across TIMING and REAL_BUG carries no
// information about which one this is, however sensible it sounds.
import { readJsonl } from '../reporters/store.ts';
import { resolve } from 'node:path';

interface Label { testId: string; runId?: string; label: string; }
interface Record_ { id?: string; testId?: string; runId?: string; error?: { message?: string }; errorMessage?: string; }

const dataset = process.argv[2] ?? 'gutenberg-local';
const truth = readJsonl<Label>(resolve(`eval/ground-truth.${dataset}.jsonl`));
const records = readJsonl<Record_>(resolve(`data/real/${dataset}/triage.jsonl`));

const errorOf = (r: Record_): string => r.error?.message ?? r.errorMessage ?? '';
const byId = new Map<string, Record_>();
for (const r of records) byId.set(`${r.runId ?? ''}|${r.testId ?? r.id ?? ''}`, r);

/** Signals a classifier can see the moment the test fails, and nothing it could only know later. */
const SIGNALS: Array<{ name: string; of: (e: string) => string }> = [
  { name: 'error says Timeout/exceeded', of: (e) => String(/timeout|exceeded/i.test(e)) },
  { name: 'error says "not visible"/"not enabled"/"not stable"', of: (e) => String(/not (visible|enabled|stable|attached)/i.test(e)) },
  { name: 'error is an assertion (expect/toBe/toEqual)', of: (e) => String(/\bexpect\(|toBe|toEqual|toHaveText|toMatch/i.test(e)) },
  { name: 'error says strict mode violation', of: (e) => String(/strict mode violation/i.test(e)) },
  { name: 'error mentions a locator', of: (e) => String(/locator|getBy|selector/i.test(e)) },
  { name: 'error says 4xx/5xx or network', of: (e) => String(/\b(4\d\d|5\d\d)\b|ECONN|ENOTFOUND|net::/i.test(e)) },
];

const labels = new Set(truth.map((t) => t.label));
console.log(`${truth.length} labelled case(s), ${records.length} harvested record(s), labels: ${[...labels].join(', ')}\n`);

for (const signal of SIGNALS) {
  // P(label | signal) against the base rate. A signal that does not move it is not a signal.
  const table = new Map<string, Map<string, number>>();
  let matched = 0;
  for (const t of truth) {
    const record = byId.get(`${t.runId ?? ''}|${t.testId}`) ?? records.find((r) => (r.testId ?? r.id) === t.testId);
    if (!record) continue;
    matched += 1;
    const key = signal.of(errorOf(record));
    if (!table.has(key)) table.set(key, new Map());
    const row = table.get(key)!;
    row.set(t.label, (row.get(t.label) ?? 0) + 1);
  }
  if (matched === 0) {
    console.log(`${signal.name}: no record matched a label - cannot measure`);
    continue;
  }
  console.log(signal.name);
  for (const [value, row] of [...table.entries()].sort()) {
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    const parts = [...row.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${Math.round((n / total) * 100)}%`);
    console.log(`   ${value.padEnd(6)} n=${String(total).padStart(4)}   ${parts.join('  ')}`);
  }
  console.log('');
}
