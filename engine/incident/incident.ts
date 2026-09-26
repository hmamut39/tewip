// Phase 16: what happened in production, read from whatever the team already has.
//
// An incident arrives in one of three shapes. Sentry writes an event with an exception, a culprit
// and a request. OpenTelemetry writes a span whose status is ERROR carrying an `exception` event.
// And very often there is nothing but a stack trace someone pasted into a ticket. All three say the
// same few things, and those few things are what a reproduction needs: what was thrown, where in
// the code, and what the system was doing at the time.
//
// This file is deterministic on purpose. Nothing here asks a model: reading a stack trace is
// parsing, and a parser can be tested against the real formats, which is what has been done.
export interface Frame {
  file: string;
  line: number;
  /** The function, when the runner recorded one. */
  fn: string;
  /** True when it is the project's own code rather than a library. */
  ours: boolean;
}

export interface Incident {
  /** One line, as the tool that recorded it titled it. */
  title: string;
  /** e.g. TypeError, ValueError, NullPointerException; empty when the source did not say. */
  errorType: string;
  errorMessage: string;
  frames: Frame[];
  /** The request or operation under way: "POST /api/checkout", "consume orders.created". */
  operation: string;
  when: string;
  /** Which shape it was read from, so a report can say where its facts came from. */
  source: 'sentry' | 'opentelemetry' | 'stack trace';
}

const LIBRARY = /[\\/](?:node_modules|site-packages|dist-packages|vendor|\.venv|venv|target[\\/]dependency|gems)[\\/]/;
const RUNTIME = /^(?:node:|internal[\\/]|java\.|javax\.|sun\.|System\.|Microsoft\.)/;

const ours = (file: string): boolean => Boolean(file) && !LIBRARY.test(file) && !RUNTIME.test(file);

const frame = (file: string, line: unknown, fn: string): Frame => ({
  file: String(file ?? '').replace(/\\/g, '/'),
  line: Number(line) || 0,
  fn: String(fn ?? ''),
  ours: ours(String(file ?? '')),
});

/** A stack trace as every language prints it, which is the fallback when there is no tool. */
export function framesFromStack(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const line of stack.split('\n')) {
    // JavaScript: "at handler (/app/src/pay.ts:42:9)" or "at /app/src/pay.ts:42:9"
    const js = /^\s*at\s+(?:(?<fn>[^(]+?)\s+\()?(?<file>[^():]+?):(?<line>\d+):\d+\)?\s*$/.exec(line);
    if (js?.groups) {
      out.push(frame(js.groups.file, js.groups.line, (js.groups.fn ?? '').trim()));
      continue;
    }
    // Python: '  File "/app/pay.py", line 42, in charge'
    const py = /^\s*File\s+"(?<file>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>\S+))?/.exec(line);
    if (py?.groups) {
      out.push(frame(py.groups.file, py.groups.line, py.groups.fn ?? ''));
      continue;
    }
    // Java and C#: "at com.shop.Pay.charge(Pay.java:42)"
    const jvm = /^\s*at\s+(?<fn>[\w.$<>]+)\((?<file>[^):]+):(?<line>\d+)\)/.exec(line);
    if (jvm?.groups) out.push(frame(jvm.groups.file, jvm.groups.line, jvm.groups.fn));
  }
  return out;
}

/** Sentry's event JSON, as its API and its "download JSON" button produce it. */
function fromSentry(event: Record<string, any>): Incident | null {
  const thrown = event.exception?.values?.at?.(-1) ?? event.exception?.values?.[0];
  if (!thrown && !event.title && !event.message) return null;
  const frames: Frame[] = (thrown?.stacktrace?.frames ?? [])
    .map((f: Record<string, any>) => frame(f.abs_path ?? f.filename ?? '', f.lineno, f.function ?? ''))
    // Sentry lists the oldest frame first; a person reads the newest first, and so does a fix.
    .reverse();
  const request = event.request ?? {};
  return {
    title: String(event.title ?? thrown?.value ?? event.message ?? 'an incident'),
    errorType: String(thrown?.type ?? ''),
    errorMessage: String(thrown?.value ?? event.message ?? ''),
    frames,
    operation: [request.method, request.url].filter(Boolean).join(' ') || String(event.culprit ?? ''),
    when: String(event.datetime ?? event.timestamp ?? ''),
    source: 'sentry',
  };
}

/** An OpenTelemetry span that failed, carrying the standard `exception` event. */
function fromOtel(span: Record<string, any>): Incident | null {
  const events = span.events ?? span.Events ?? [];
  const thrown = events.find?.((e: Record<string, any>) => (e.name ?? '') === 'exception');
  const status = span.status?.code ?? span.status?.Code ?? '';
  if (!thrown && !/ERROR|STATUS_CODE_ERROR|2/.test(String(status))) return null;
  const attrs: Record<string, any> = {};
  // OTLP writes attributes either as a map or as a list of {key,value}; both are seen in exports.
  const raw = thrown?.attributes ?? {};
  if (Array.isArray(raw)) for (const a of raw) attrs[a.key] = a.value?.stringValue ?? a.value?.string_value ?? a.value;
  else Object.assign(attrs, raw);
  const stack = String(attrs['exception.stacktrace'] ?? '');
  return {
    title: String(span.name ?? attrs['exception.type'] ?? 'a failed operation'),
    errorType: String(attrs['exception.type'] ?? ''),
    errorMessage: String(attrs['exception.message'] ?? span.status?.message ?? ''),
    frames: framesFromStack(stack),
    operation: String(span.name ?? ''),
    when: String(span.startTime ?? span.startTimeUnixNano ?? ''),
    source: 'opentelemetry',
  };
}

/** Whatever was pasted: the first line is the error, the rest is the stack. */
function fromText(text: string): Incident {
  const lines = text.split('\n');
  const head = lines.find((l) => l.trim()) ?? '';
  const typed = /^\s*(?<type>[\w.]*(?:Error|Exception|Fault))\b:?\s*(?<message>.*)$/.exec(head);
  return {
    title: head.trim().slice(0, 160) || 'an incident',
    errorType: typed?.groups?.type ?? '',
    errorMessage: (typed?.groups?.message ?? head).trim(),
    frames: framesFromStack(text),
    operation: '',
    when: '',
    source: 'stack trace',
  };
}

/** Reads an incident from a file's contents, whichever of the three shapes it is in. */
export function readIncident(contents: string): Incident {
  const text = contents.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const one = Array.isArray(parsed) ? parsed[0] : parsed;
      // A Sentry event and an OTel span are both objects; each is recognised by what it carries.
      const sentry = one?.exception || one?.culprit || one?.event_id ? fromSentry(one) : null;
      if (sentry) return sentry;
      const otel = fromOtel(one?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0] ?? one?.span ?? one);
      if (otel) return otel;
    } catch {
      // Not JSON after all: fall through and read it as a pasted stack trace.
    }
  }
  return fromText(text);
}

/** The frames in the project's own code, newest first: where a reproduction has to aim. */
export const ourFrames = (incident: Incident): Frame[] => incident.frames.filter((f) => f.ours);
