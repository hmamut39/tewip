// Imports Playwright blob reports as triage records in the same shape the reporter writes,
// plus one run summary with every attempt. Two sources: a CI artifact zip holding one
// report-N.zip per shard (harvesting public repos), or a local blob-report/ directory (the
// GitHub Action, right after the tests ran). Consumers only need Playwright's built-in
// `blob` reporter, no triage-agent code in their config.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { PROJECT_ROOT } from '../../reporters/store.ts';
import { SCHEMA_VERSION, type RunSummary, type TriageAttachment, type TriageRecord } from '../../reporters/types.ts';
import { readZipBuffer } from '../trace/zip.ts';

export interface ImportMeta {
  /** Our run id, e.g. "gutenberg-34425132550-a1". */
  runId: string;
  gitSha: string;
  branch?: string;
  /**
   * When set, record.file becomes the spec path relative to this directory (needed to edit
   * the spec, e.g. by auto-fix in CI). Otherwise it is the path relative to the test dir.
   */
  workspace?: string;
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

export interface ImportResult {
  records: TriageRecord[];
  summary: RunSummary;
  /** Shards whose blob was corrupt; their tests are missing from this run. */
  skippedShards: string[];
}

// Screenshots and videos are skipped: the diagnosis layers read traces and error-context only.
const KEPT_ATTACHMENTS = new Set(['trace', 'error-context']);
const MAX_ERROR_CHARS = 8000;
const clip = (s: string) => (s.length <= MAX_ERROR_CHARS ? s : `${s.slice(0, MAX_ERROR_CHARS)}…`);
const slash = (p: string) => p.split(sep).join('/');

/** testId hash -> readable test id ("project > file > describe > title") and spec file. */
function titlesOf(events: BlobEvent[], workspace?: string): Map<string, { id: string; file: string }> {
  const out = new Map<string, { id: string; file: string }>();
  const walk = (entries: SuiteEntry[] = [], path: string[], file: string, testDir: string) => {
    for (const e of entries) {
      const f = e.location?.file ?? file;
      if (e.testId) {
        const abs = isAbsolute(f) ? f : join(testDir, f);
        const shown = workspace && testDir ? slash(relative(workspace, abs)) : f;
        out.set(e.testId, { id: [...path, e.title].filter(Boolean).join(' > '), file: shown });
      } else walk(e.entries, [...path, e.title], f, testDir);
    }
  };
  for (const e of events.filter((x) => x.method === 'onProject')) walk(e.params.project.suites, [e.params.project.name], '', e.params.project.testDir ?? '');
  return out;
}

function parseEvents(buf: Buffer): BlobEvent[] {
  return buf
    .toString('utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as BlobEvent);
}

/** A CI artifact zip: one report-N.zip per shard, or a single shard's report.jsonl directly. */
export function importBlobArtifact(artifact: Buffer, meta: ImportMeta, filesDir: string): ImportResult {
  const outer = readZipBuffer(artifact, (n) => n.endsWith('.zip') || n === 'report.jsonl');
  const shards: Array<[string, Buffer]> = outer.has('report.jsonl') ? [['artifact', artifact]] : [...outer.entries()].filter(([n]) => n.endsWith('.zip'));
  return importShards(shards, meta, filesDir);
}

/** A local blob-report/ directory as the blob reporter writes it (report*.zip per shard). */
export function importBlobReportDir(dir: string, meta: ImportMeta, filesDir: string): ImportResult {
  const shards = readdirSync(dir)
    .filter((n) => n.endsWith('.zip'))
    .map((n): [string, Buffer] => [n, readFileSync(join(dir, n))]);
  return importShards(shards, meta, filesDir);
}

function importShards(shards: Array<[string, Buffer]>, meta: ImportMeta, filesDir: string): ImportResult {
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
    const titles = titlesOf(events, meta.workspace);
    const begins = new Map<string, { retry: number; startTime: number }>();
    const attachmentsByResult = new Map<string, Array<{ name: string; path: string; contentType: string }>>();
    for (const e of events) {
      if (e.method === 'onTestBegin') begins.set(e.params.result.id, { retry: e.params.result.retry, startTime: e.params.result.startTime });
      if (e.method === 'onAttach') attachmentsByResult.set(e.params.resultId, [...(attachmentsByResult.get(e.params.resultId) ?? []), ...e.params.attachments]);
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
      failed.push({
        wanted: all.filter((a, i) => all.findIndex((b) => b.path === a.path) === i),
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
        const attachment: TriageAttachment = { name: a.name as TriageAttachment['name'], contentType: a.contentType, path: slash(relative(PROJECT_ROOT, target)) };
        record.attachments.push(attachment);
      }
      records.push(record);
    }
  }

  const summary: RunSummary = {
    schemaVersion: SCHEMA_VERSION,
    runId: meta.runId,
    gitSha: meta.gitSha,
    ...(meta.branch ? { branch: meta.branch } : {}),
    startedAt: new Date(Number.isFinite(startedAt) ? startedAt : 0).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    status: runStatus,
    attempts,
  };
  return { records, summary, skippedShards };
}
