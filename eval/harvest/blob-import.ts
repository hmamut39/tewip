// Imports a CI run's Playwright blob reports (one inner report-N.zip per shard) as triage
// records in the same shape the reporter writes, plus one run summary with every attempt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { readZipBuffer } from '../../engine/trace/zip.ts';
import { PROJECT_ROOT } from '../../reporters/store.ts';
import { SCHEMA_VERSION, type RunSummary, type TriageAttachment, type TriageRecord } from '../../reporters/types.ts';

export interface ImportMeta {
  /** Our run id, e.g. "gutenberg-34425132550-a1". */
  runId: string;
  gitSha: string;
}

interface BlobEvent {
  method: string;
  params: any;
}

interface SuiteEntry {
  title: string;
  testId?: string;
  location?: { file: string };
  entries?: SuiteEntry[];
}

// Screenshots and videos are skipped: the diagnosis layers read traces and error-context only.
const KEPT_ATTACHMENTS = new Set(['trace', 'error-context']);
const MAX_ERROR_CHARS = 8000;
const clip = (s: string) => (s.length <= MAX_ERROR_CHARS ? s : `${s.slice(0, MAX_ERROR_CHARS)}…`);

/** testId hash -> readable test id ("project > file > describe > title") and spec file. */
function titlesOf(events: BlobEvent[]): Map<string, { id: string; file: string }> {
  const out = new Map<string, { id: string; file: string }>();
  const walk = (entries: SuiteEntry[] = [], path: string[], file: string) => {
    for (const e of entries) {
      const f = e.location?.file ?? file;
      if (e.testId) out.set(e.testId, { id: [...path, e.title].filter(Boolean).join(' > '), file: f });
      else walk(e.entries, [...path, e.title], f);
    }
  };
  for (const e of events.filter((x) => x.method === 'onProject')) walk(e.params.project.suites, [e.params.project.name], '');
  return out;
}

function parseEvents(buf: Buffer): BlobEvent[] {
  return buf
    .toString('utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as BlobEvent);
}

export interface ImportResult {
  records: TriageRecord[];
  summary: RunSummary;
  /** Shards whose blob was corrupt in the artifact; their tests are missing from this run. */
  skippedShards: string[];
}

export function importBlobArtifact(artifact: Buffer, meta: ImportMeta, filesDir: string): ImportResult {
  // The artifact holds report-N.zip per shard; a single-shard artifact may hold report.jsonl directly.
  const outer = readZipBuffer(artifact, (n) => n.endsWith('.zip') || n === 'report.jsonl');
  const shards: Array<[string, Buffer]> = outer.has('report.jsonl') ? [['artifact', artifact]] : [...outer.entries()].filter(([n]) => n.endsWith('.zip'));

  const records: TriageRecord[] = [];
  const attempts: Record<string, number> = {};
  const skippedShards: string[] = [];
  let startedAt = Number.POSITIVE_INFINITY;
  let finishedAt = 0;
  let runStatus = 'passed';
  mkdirSync(filesDir, { recursive: true });

  for (const [shardName, shard] of shards) {
    let events: BlobEvent[];
    try {
      events = parseEvents(readZipBuffer(shard, (n) => n === 'report.jsonl').get('report.jsonl') ?? Buffer.alloc(0));
    } catch {
      // Seen in real artifacts: a shard blob truncated at upload. Keep the other shards.
      skippedShards.push(shardName);
      continue;
    }
    const titles = titlesOf(events);
    const begins = new Map<string, { retry: number; startTime: number }>();
    const attachmentsByResult = new Map<string, Array<{ name: string; path: string; contentType: string }>>();
    for (const e of events) {
      if (e.method === 'onTestBegin') begins.set(e.params.result.id, { retry: e.params.result.retry, startTime: e.params.result.startTime });
      if (e.method === 'onAttach') {
        const list = attachmentsByResult.get(e.params.resultId) ?? [];
        list.push(...e.params.attachments);
        attachmentsByResult.set(e.params.resultId, list);
      }
      if (e.method === 'onEnd') {
        startedAt = Math.min(startedAt, e.params.result.startTime);
        finishedAt = Math.max(finishedAt, e.params.result.startTime + e.params.result.duration);
        if (e.params.result.status !== 'passed') runStatus = e.params.result.status;
      }
    }

    const failed: Array<{ record: TriageRecord; wanted: Array<{ name: string; path: string; contentType: string }> }> = [];
    for (const e of events.filter((x) => x.method === 'onTestEnd')) {
      const { test, result } = e.params;
      const title = titles.get(test.testId) ?? { id: test.testId, file: '' };
      if (result.status !== 'skipped' && result.status !== 'interrupted') attempts[title.id] = (attempts[title.id] ?? 0) + 1;
      if (result.status !== 'failed' && result.status !== 'timedOut') continue;

      const begin = begins.get(result.id) ?? { retry: 0, startTime: startedAt };
      const error = result.errors?.[0] ?? {};
      const all = (attachmentsByResult.get(result.id) ?? []).filter((a) => KEPT_ATTACHMENTS.has(a.name) && a.path);
      const wanted = all.filter((a, i) => all.findIndex((b) => b.path === a.path) === i);
      failed.push({
        wanted,
        record: {
          schemaVersion: SCHEMA_VERSION,
          testId: title.id,
          file: title.file,
          status: result.status,
          errorMessage: clip(stripVTControlCharacters(error.message ?? '')),
          errorStack: clip(stripVTControlCharacters(error.stack ?? '')),
          duration: result.duration,
          retry: begin.retry,
          attachments: [],
          runId: meta.runId,
          gitSha: meta.gitSha,
          timestamp: new Date(begin.startTime + result.duration).toISOString(),
        },
      });
    }

    // Only the resources failed attempts point at are extracted; the rest of the shard is skipped.
    const needed = new Set(failed.flatMap((f) => f.wanted.map((a) => a.path)));
    let resources = new Map<string, Buffer>();
    try {
      resources = readZipBuffer(shard, (n) => needed.has(n));
    } catch {
      // A damaged resource leaves the records without attachments rather than dropping them.
    }
    for (const { record, wanted } of failed) {
      for (const a of wanted) {
        const data = resources.get(a.path);
        if (!data) continue;
        const target = join(filesDir, basename(a.path));
        writeFileSync(target, data);
        const attachment: TriageAttachment = { name: a.name as TriageAttachment['name'], contentType: a.contentType, path: relative(PROJECT_ROOT, target).split(sep).join('/') };
        record.attachments.push(attachment);
      }
      records.push(record);
    }
  }

  const summary: RunSummary = {
    schemaVersion: SCHEMA_VERSION,
    runId: meta.runId,
    gitSha: meta.gitSha,
    startedAt: new Date(Number.isFinite(startedAt) ? startedAt : 0).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    status: runStatus,
    attempts,
  };
  return { records, summary, skippedShards };
}
