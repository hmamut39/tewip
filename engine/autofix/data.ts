// Phase 8, the test-data half: a test that creates a record which is already there. The cause is
// almost always a value written into the test by hand - "user@example.com", "my-project" - so the
// second run of the suite, or a leftover from another test, collides with it.
//
// The fix is to make that value unique per run. What makes it verifiable is a property no other fix
// has: running the fixed test TWICE proves it. A fix that is not really unique collides with the
// record its own first run created, so the second run fails. One pass would prove nothing.
//
// Often the database says only which constraint was violated and not which value, and then there is
// nothing safe to change: this refuses and says so rather than guessing at the test's data.

export interface Collision {
  /** The column or constraint that was violated, when the database names one. */
  where: string;
  /** The value that already existed, when the database prints it. */
  value: string | null;
}

const COLLISION_PATTERNS: Array<{ pattern: RegExp; where: number; value?: number }> = [
  // Postgres: duplicate key value violates unique constraint "users_email_key"
  //           DETAIL: Key (email)=(user@example.com) already exists.
  { pattern: /Key \(([^)]+)\)=\(([^)]+)\) already exists/i, where: 1, value: 2 },
  { pattern: /duplicate key value violates unique constraint "([^"]+)"/i, where: 1 },
  // SQLite / MySQL
  { pattern: /UNIQUE constraint failed: ([\w.]+)/i, where: 1 },
  { pattern: /Duplicate entry '([^']+)' for key '([^']+)'/i, where: 2, value: 1 },
  // Application-level wording
  { pattern: /(?:a |the )?([\w ]{3,30}?) (?:with (?:that|this) [\w ]+ )?already exists/i, where: 1 },
];

/** What collided, from the failure message, or null when the message does not say. */
export function collision(message: string): Collision | null {
  for (const { pattern, where, value } of COLLISION_PATTERNS) {
    const m = message.match(pattern);
    if (m) return { where: m[where].trim(), value: value ? m[value].trim() : null };
  }
  return null;
}

export interface LiteralSite {
  line: number;
  start: number;
  end: number;
  quote: string;
  text: string;
}

/** Where a value is written literally in the test file: those are the places worth making unique. */
export function findLiteral(source: string, value: string): LiteralSite[] {
  const out: LiteralSite[] = [];
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of source.matchAll(new RegExp(`(['"\`])${escaped}\\1`, 'g'))) {
    const start = m.index ?? 0;
    out.push({ line: source.slice(0, start).split('\n').length, start, end: start + m[0].length, quote: m[1], text: m[0] });
  }
  return out;
}

export type Language = 'js' | 'python' | 'java' | 'other';

/** The language of a test file, which decides how a unique value is written. */
export function languageOf(file: string): Language {
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'js';
  if (/\.py$/.test(file)) return 'python';
  if (/\.(java|kt)$/.test(file)) return 'java';
  return 'other';
}

export interface DataFixCandidate {
  expression: string;
  why: string;
}

/**
 * How to write "this value, but different every run", in the test's own language. An email keeps its
 * domain and gets a +tag, because many systems validate the shape; anything else gets a suffix.
 */
export function dataFixCandidates(value: string, language: Language): DataFixCandidate[] {
  const email = value.match(/^([^@\s]+)@([^@\s]+)$/);
  const unique = { js: '${Date.now()}', python: '{int(time.time() * 1000)}', java: '" + System.currentTimeMillis() + "', other: '' }[language];
  if (!unique) return [];
  const why = `"${value}" was written into the test by hand, so the next run (or another test) creates the same record. This makes it different every run.`;
  if (language === 'java') {
    const expression = email ? `"${email[1]}+" + System.currentTimeMillis() + "@${email[2]}"` : `"${value}-" + System.currentTimeMillis()`;
    return [{ expression, why }];
  }
  const open = language === 'python' ? 'f"' : '`';
  const close = language === 'python' ? '"' : '`';
  const body = email ? `${email[1]}+${unique}@${email[2]}` : `${value}-${unique}`;
  return [{ expression: `${open}${body}${close}`, why }];
}

/** The file with one literal replaced by the unique expression. */
export function applyDataFix(source: string, site: LiteralSite, expression: string): string {
  return source.slice(0, site.start) + expression + source.slice(site.end);
}
