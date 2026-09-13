// Condenses a Playwright trace.zip into the facts a triage model needs: the final DOM,
// failed network requests, console errors and the last test steps. Never raw logs.
import { stripVTControlCharacters } from 'node:util';
import { lastMainFrameDom, notableElements, type FrameSnapshot } from './dom.ts';
import { readZipEntries } from './zip.ts';

export interface TraceSummary {
  pageUrl: string | null;
  /** Compact tags for elements a selector could target, from the last DOM snapshot. */
  domElements: string[];
  domElementsOmitted: number;
  network: {
    requests: number;
    /** HTTP status >= 400 or no response at all. */
    failed: Array<{ method: string; url: string; status: number | null; error?: string }>;
  };
  console: { errors: string[]; warnings: number };
  pageErrors: string[];
  /** Test-body steps (actions and expects), last ones, with duration and outcome. */
  steps: string[];
}

interface TraceEvent {
  type: string;
  [key: string]: any;
}

const MAX_STEPS = 12;
const MAX_ITEMS = 10;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function parseJsonl(buffers: Buffer[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const buf of buffers) {
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TraceEvent);
      } catch {
        // A trace cut short by a crash can end with a partial line; skip it.
      }
    }
  }
  return events;
}

/** Keeps origin + path, drops query strings (they can carry tokens) and fragments. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return clip(url, 120);
  }
}

function summarizeSteps(testEvents: TraceEvent[], contextEvents: TraceEvent[]): string[] {
  const after = new Map(testEvents.filter((e) => e.type === 'after').map((e) => [e.callId, e]));
  // Protocol-level calls carry the selector / url; they link to test steps through stepId.
  const params = new Map(contextEvents.filter((e) => e.type === 'before' && e.stepId).map((e) => [e.stepId, e.params ?? {}]));
  return testEvents
    .filter((e) => e.type === 'before' && !e.parentId && /^(pw:api|expect)@/.test(e.callId ?? ''))
    .map((e) => {
      const end = after.get(e.callId);
      const p = params.get(e.callId) ?? {};
      const target = p.selector ?? p.url ?? p.event ?? p.expression ?? '';
      const ms = end?.endTime !== undefined ? Math.round(end.endTime - e.startTime) : null;
      const outcome = end?.error ? ` FAILED: ${clip(stripVTControlCharacters(String(end.error.message ?? '')).split('\n')[0], 100)}` : '';
      return `${e.title}${target ? ` ${clip(String(target), 80)}` : ''}${ms !== null ? ` (${ms}ms)` : ''}${outcome}`;
    })
    .slice(-MAX_STEPS);
}

export function summarizeTrace(tracePath: string): TraceSummary {
  const entries = readZipEntries(tracePath, (name) => /^(\d+-trace\.(trace|network)|test\.trace)$/.test(name));
  const byKind = (re: RegExp) => [...entries].filter(([name]) => re.test(name)).map(([, buf]) => buf);
  const contextEvents = parseJsonl(byKind(/^\d+-trace\.trace$/));
  const networkEvents = parseJsonl(byKind(/^\d+-trace\.network$/));
  const testEvents = parseJsonl(byKind(/^test\.trace$/));

  const snapshots = contextEvents.filter((e) => e.type === 'frame-snapshot').map((e) => e.snapshot as FrameSnapshot);
  const dom = lastMainFrameDom(snapshots);
  const notable = dom ? notableElements(dom.root) : { elements: [], omitted: 0 };

  const resources = networkEvents.filter((e) => e.type === 'resource-snapshot').map((e) => e.snapshot);
  const failed = resources
    .filter((r) => !r.response || r.response.status >= 400 || r.response.status <= 0 || r.response._failureText)
    .slice(0, MAX_ITEMS)
    .map((r) => ({
      method: String(r.request?.method ?? 'GET'),
      url: shortUrl(String(r.request?.url ?? '')),
      status: r.response && r.response.status > 0 ? Number(r.response.status) : null,
      ...(r.response?._failureText ? { error: String(r.response._failureText) } : {}),
    }));

  const consoleEvents = contextEvents.filter((e) => e.type === 'console');
  const pageErrors = contextEvents
    .filter((e) => e.type === 'event' && e.method === 'pageError')
    .map((e) => clip(String(e.params?.error?.error?.message ?? e.params?.error?.message ?? JSON.stringify(e.params?.error ?? '')), 200))
    .slice(0, MAX_ITEMS);

  return {
    pageUrl: dom ? shortUrl(dom.url) : null,
    domElements: notable.elements,
    domElementsOmitted: notable.omitted,
    network: { requests: resources.length, failed },
    console: {
      errors: consoleEvents.filter((e) => e.messageType === 'error').map((e) => clip(String(e.text), 200)).slice(0, MAX_ITEMS),
      warnings: consoleEvents.filter((e) => e.messageType === 'warning').length,
    },
    pageErrors,
    steps: summarizeSteps(testEvents, contextEvents),
  };
}
