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

/** Served over the network, so not a path in this repository however much of it is ours. */
const SERVED = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Does this name a file at all? A path has a separator, or at least a file extension: `Pay.java`
 * from a JVM frame is a file, and `debugger eval code` is not.
 */
const namesAFile = (file: string): boolean => /[\\/]/.test(file) || /\.[a-z0-9]{1,10}$/i.test(file);

/**
 * Is this the project's own code - somewhere a reproduction could be written against?
 *
 * The two tests above used to be the whole of it, so anything that was not a library path was
 * claimed as this project's code, including things that are not files at all. Firefox names an
 * evaluated script `debugger eval code`, and a browser frame names a URL. On a real gutenberg
 * trace `incident` reported **"Your code in the trace: @debugger eval code:1"**, and then told the
 * test writer to "call the code in @debugger eval code around line 1 the way production did". The
 * project's actual frames - transform-block-to.ts:14 and list.spec.js:309 - were sixth and seventh
 * in the list, behind five things that were not code.
 *
 * Both kinds still enter `frames`, so nothing in the trace is lost; they are only not offered as
 * the place to write a test. "No file of yours appears in the trace" is a usable answer. A
 * confident pointer at a file that does not exist is not.
 */
const ours = (file: string): boolean =>
  Boolean(file) && !LIBRARY.test(file) && !RUNTIME.test(file) && !SERVED.test(file) && namesAFile(file);

/**
 * A `file://` URL back into the path it names.
 *
 * Node has printed ESM stack frames as URLs since v12, and ESM is the default for every project with
 * `"type": "module"` - which this one is. `file:///app/src/pay.ts` and `file:///C:/app/src/pay.ts`
 * are what a real trace contains, and a path is what every later step needs.
 */
function asPath(file: string): string {
  const text = String(file ?? '').replace(/\\/g, '/');
  if (!/^file:\/\//i.test(text)) return text;
  const withoutScheme = text.replace(/^file:\/\/\/?/i, '');
  // A Windows drive keeps its letter; everything else is rooted.
  const path = /^[a-z]:/i.test(withoutScheme) ? withoutScheme : `/${withoutScheme}`;
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // a malformed escape is not a reason to lose the frame
  }
}

/**
 * Firefox and Safari print `name@location`, not `at name (location)`, and Playwright passes those
 * lines through with its own `at ` prefix bolted on - so a real trace contains
 * `at Ai@http://host/bundle.js?ver=x:2:58423`. Read as a V8 frame, the whole thing including the
 * function name becomes the file.
 *
 * The separator is only honoured when what precedes it holds no path separator, because
 * `/app/node_modules/@scope/pkg/index.js` is a path with an `@` in it and splitting that would
 * destroy it.
 */
function splitFirefox(file: string, fn: string): { file: string; fn: string } {
  const at = /^(?<fn>[^\s/\\@]*)@(?<rest>.+)$/.exec(file);
  if (!at?.groups) return { file, fn };
  return { file: at.groups.rest, fn: fn || at.groups.fn };
}

const frame = (file: string, line: unknown, fn: string): Frame => {
  const split = splitFirefox(asPath(file), String(fn ?? ''));
  return { file: split.file, line: Number(line) || 0, fn: split.fn, ours: ours(split.file) };
};

/** A stack trace as every language prints it, which is the fallback when there is no tool. */
export function framesFromStack(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const line of stack.split('\n')) {
    // JavaScript: "at handler (/app/src/pay.ts:42:9)" or "at /app/src/pay.ts:42:9", and - what a
    // modern Node actually prints - "at handler (file:///C:/app/src/pay.ts:42:9)".
    //
    // The file group was `[^():]+?`: no colons allowed. A `file://` URL has one in the scheme and a
    // Windows path has another in the drive letter, so **not one ESM frame could be read** - on any
    // platform, in any project with `"type": "module"`, which is most of them and is this one. The
    // command's whole premise is writing a test against the code the trace names, and it could not
    // name the code. Found on a real trace from this repository: `incident` reported "it names no
    // file inside this project" about `engine/access/render.ts:129`, which is in this project.
    //
    // The group now takes anything and the tail anchors it: `:digits:digits` at the end of the line
    // is what makes a JavaScript frame, and a JVM frame has only one number so it still falls through.
    const js = /^\s*at\s+(?:(?<fn>[^(]+?)\s+\()?(?<file>.+?):(?<line>\d+):\d+\)?\s*$/.exec(line);
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
