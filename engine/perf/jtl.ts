// Phase 39: reading a JMeter results file.
//
// Two things made this worth doing properly.
//
// **Tewip could not read one at all.** The importer handled `.jtl` only as XML, and CSV is JMeter's
// default and what every real repository has - so `importJunit` answered "not an XML document: no
// root element" on genuine JMeter output while the help text advertised JMeter support.
//
// **And a .jtl is the best performance data Tewip has ever been handed.** A k6 summary gives six
// aggregates per metric and no samples, which is why Phase 30's comparison had to be a crude range
// check. A .jtl has one row per request: real samples, per label, which support an actual
// statistical test. The better answer was always sitting in a format that would not open.
//
// The parser is a real CSV reader rather than a line split, and that is not fastidiousness. In the
// first real file read here - NikeshMan16/JmeterPerformance_testing_Project - the quoted
// failureMessage of a 400 response contains a comma *and a newline*, so one logical record spans
// seven physical lines. Splitting on newlines would have produced six corrupt rows out of one.
import { readFileSync } from 'node:fs';

export interface Sample {
  label: string;
  /** Milliseconds, JMeter's `elapsed`. */
  elapsed: number;
  success: boolean;
  responseCode: string;
}

export interface LabelSamples {
  label: string;
  /** Every response time recorded for this label, in the order they happened. */
  elapsed: number[];
  failed: number;
  total: number;
  /** The response codes of the failures, worst first, for a report that says what went wrong. */
  codes: Array<{ code: string; times: number }>;
}

/**
 * RFC 4180 with JMeter's habits: quoted fields may contain commas, newlines and doubled quotes.
 *
 * Returned as rows of raw strings; nothing is interpreted here, because deciding what a column
 * means is the caller's job and JMeter's column set is configurable.
 */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  // A byte order mark would otherwise become part of the first column's name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      field = '';
      // A blank line is not a record.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** JMeter's column names, which are configurable, so each is looked up rather than counted. */
function columns(header: string[]): Record<string, number> {
  const at: Record<string, number> = {};
  header.forEach((name, i) => {
    at[name.trim()] = i;
  });
  return at;
}

const CSV_HEADER = /(^|,)\s*timeStamp\s*(,|$)/;

/** True of a CSV results file, as opposed to the XML form or something else entirely. */
export function looksLikeCsvJtl(text: string): boolean {
  const firstLine = text.slice(0, 2000).split(/\r?\n/)[0] ?? '';
  return CSV_HEADER.test(firstLine) && firstLine.includes('elapsed');
}

export function readJtlSamples(path: string): Sample[] {
  const text = readFileSync(path, 'utf8');
  if (!looksLikeCsvJtl(text)) {
    throw new Error(
      `${path} is not a CSV JMeter results file: Tewip looked for a header row naming timeStamp and elapsed. ` +
        'JMeter writes one by default; if yours is XML, it is read by `tewip explain` instead.',
    );
  }
  const rows = readCsv(text);
  const at = columns(rows[0] ?? []);
  const elapsedAt = at.elapsed;
  const labelAt = at.label;
  if (elapsedAt === undefined || labelAt === undefined) {
    throw new Error(`${path} has no elapsed or label column, so there is nothing to measure.`);
  }

  const out: Sample[] = [];
  for (const row of rows.slice(1)) {
    // A short row is a truncated write - a run killed mid-flush - and inventing values for it would
    // put a zero into a latency distribution, which is the one place a zero does real damage.
    if (row.length <= Math.max(elapsedAt, labelAt)) continue;
    const elapsed = Number(row[elapsedAt]);
    if (!Number.isFinite(elapsed) || elapsed < 0) continue;
    const success = at.success === undefined ? true : row[at.success]?.trim().toLowerCase() === 'true';
    out.push({
      label: (row[labelAt] ?? '').trim(),
      elapsed,
      success,
      responseCode: (at.responseCode === undefined ? '' : (row[at.responseCode] ?? '')).trim(),
    });
  }
  return out;
}

/** The samples grouped by what was being requested, busiest first. */
export function byLabel(samples: Sample[]): LabelSamples[] {
  const groups = new Map<string, LabelSamples>();
  const codes = new Map<string, Map<string, number>>();
  for (const s of samples) {
    let group = groups.get(s.label);
    if (!group) {
      group = { label: s.label, elapsed: [], failed: 0, total: 0, codes: [] };
      groups.set(s.label, group);
      codes.set(s.label, new Map());
    }
    group.elapsed.push(s.elapsed);
    group.total += 1;
    if (!s.success) {
      group.failed += 1;
      const seen = codes.get(s.label)!;
      const code = s.responseCode === '' ? 'no response code' : s.responseCode;
      seen.set(code, (seen.get(code) ?? 0) + 1);
    }
  }
  for (const [label, seen] of codes) {
    groups.get(label)!.codes = [...seen].map(([code, times]) => ({ code, times })).sort((a, b) => b.times - a.times);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

/** The whole run as one label, for the headline number. */
export const ALL_REQUESTS = 'all requests';

export function overall(samples: Sample[]): LabelSamples {
  return {
    label: ALL_REQUESTS,
    elapsed: samples.map((s) => s.elapsed),
    failed: samples.filter((s) => !s.success).length,
    total: samples.length,
    codes: [],
  };
}
