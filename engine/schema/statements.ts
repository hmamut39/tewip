// Reading a schema change: the statements, and what each one does to a live database.
//
// Phase 26 exists because the worst outage most companies have is not a failing test, it is a migration.
// A column dropped while the old deployment still reads it. An index built without CONCURRENTLY, locking
// writes on the busiest table for twenty minutes. A NOT NULL added to a populated table. These are not
// subtle - they are known, documented, and a tool can name every one of them from the text of the
// migration. What is missing is anybody doing it in the same place the rest of the quality work happens.
//
// The discipline is the same as everywhere else here: say what the statement *does*, never invent what it
// will cost. Tewip cannot see how big the table is or how busy the database is, so it says "this rewrites
// the table, which blocks writes for as long as it takes" and leaves the size to the person who knows it.
export type Risk = 'breaks-old-code' | 'locks-writes' | 'destroys-data' | 'irreversible' | 'slow' | 'fine';

export interface Finding {
  /** The statement, trimmed, as it appears. */
  statement: string;
  line: number;
  risk: Risk;
  /** What it does, in a sentence somebody can act on. */
  what: string;
  /** The safe way to do the same thing, where there is one. */
  instead: string;
  /** The table it touches, when it can be read, so the code check knows what to look for. */
  table: string;
  /** The column it touches, when there is one. */
  column: string;
}

const CLEAN = (s: string) => s.replace(/\s+/g, ' ').trim();
const NAME = String.raw`[\w."\[\]` + "`" + String.raw`]+`;

interface Rule {
  find: RegExp;
  risk: Risk;
  what: (m: RegExpExecArray) => string;
  instead: string;
  table?: (m: RegExpExecArray) => string;
  column?: (m: RegExpExecArray) => string;
}

/**
 * What a statement does. Ordered: the first rule that matches decides, so the most serious reading of a
 * statement wins over a milder one.
 */
const RULES: Rule[] = [
  {
    find: new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${NAME})`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${bare(m[1])} and everything in it`,
    instead: 'stop writing to it, ship that, confirm nothing reads it, and drop it in a later release - a drop cannot be rolled back by deploying the old code again',
    table: (m) => bare(m[1]),
  },
  {
    find: new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(${NAME})`, 'i'),
    risk: 'destroys-data',
    what: (m) => `empties the table ${bare(m[1])}`,
    instead: 'delete in batches if this is cleanup, or keep the rows and stop reading them',
    table: (m) => bare(m[1]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})[\s\S]*?\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${NAME})`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `drops the column ${bare(m[2])} from ${bare(m[1])}`,
    instead: 'deploy code that no longer selects or writes the column, then drop it in a later migration. During a rolling deploy the old version is still running and will fail on a column that is gone',
    table: (m) => bare(m[1]),
    column: (m) => bare(m[2]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})\s+RENAME\s+(?:COLUMN\s+)?(${NAME})\s+TO\s+(${NAME})`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames ${bare(m[1])}.${bare(m[2])} to ${bare(m[3])}`,
    instead: 'add the new column, write to both, move readers over, then remove the old one. A rename is a drop and an add at the same instant, and no deployment is that instant',
    table: (m) => bare(m[1]),
    column: (m) => bare(m[2]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})\s+RENAME\s+TO\s+(${NAME})`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames the table ${bare(m[1])} to ${bare(m[2])}`,
    instead: 'create a view with the old name, or move readers first. Every query naming the old table fails the moment this runs',
    table: (m) => bare(m[1]),
  },
  {
    find: new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})?\s*ON\s+(${NAME})`, 'i'),
    risk: 'locks-writes',
    what: (m) => `builds an index on ${bare(m[2])} while holding a lock that blocks writes to it`,
    instead: 'CREATE INDEX CONCURRENTLY (Postgres), or ALGORITHM=INPLACE LOCK=NONE (MySQL). On a large table the plain form blocks every write until it finishes',
    table: (m) => bare(m[2]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})\s+(?:ALTER|MODIFY)\s+(?:COLUMN\s+)?(${NAME})[\s\S]*?\bSET\s+NOT\s+NULL`, 'i'),
    risk: 'locks-writes',
    what: (m) => `makes ${bare(m[1])}.${bare(m[2])} NOT NULL, which reads every existing row under a lock`,
    instead: 'add a CHECK (column IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT separately, then set NOT NULL (Postgres 12+). The direct form scans the whole table while blocking writes',
    table: (m) => bare(m[1]),
    column: (m) => bare(m[2]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})\s+(?:ALTER|MODIFY|CHANGE)\s+(?:COLUMN\s+)?(${NAME})[\s\S]*?\b(?:TYPE|SET\s+DATA\s+TYPE)\b`, 'i'),
    risk: 'locks-writes',
    what: (m) => `changes the type of ${bare(m[1])}.${bare(m[2])}, which usually rewrites the whole table`,
    instead: 'add a new column of the new type, backfill in batches, switch the readers, then drop the old one. A type change holds an exclusive lock for the rewrite',
    table: (m) => bare(m[1]),
    column: (m) => bare(m[2]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})\s+ADD\s+(?:CONSTRAINT\s+${NAME}\s+)?FOREIGN\s+KEY(?![\s\S]*NOT\s+VALID)`, 'i'),
    risk: 'locks-writes',
    what: (m) => `adds a foreign key to ${bare(m[1])}, which checks every existing row under a lock on both tables`,
    instead: 'ADD CONSTRAINT ... NOT VALID, then VALIDATE CONSTRAINT, which takes a weaker lock',
    table: (m) => bare(m[1]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})\s+ADD\s+(?:COLUMN\s+)?(${NAME})[\s\S]*?\bNOT\s+NULL\b(?![\s\S]*\bDEFAULT\b)`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `adds ${bare(m[2])} to ${bare(m[1])} as NOT NULL with no default`,
    instead: 'add it nullable or with a default. Without one, every insert from code that does not know about the column fails - including the version still running during the deploy',
    table: (m) => bare(m[1]),
    column: (m) => bare(m[2]),
  },
  {
    find: new RegExp(String.raw`\bALTER\s+TABLE\s+(${NAME})\s+ADD\s+(?:CONSTRAINT\s+${NAME}\s+)?UNIQUE`, 'i'),
    risk: 'locks-writes',
    what: (m) => `adds a unique constraint to ${bare(m[1])}, which builds an index under a lock`,
    instead: 'CREATE UNIQUE INDEX CONCURRENTLY first, then add the constraint using that index',
    table: (m) => bare(m[1]),
  },
  {
    find: /\bVACUUM\s+FULL\b|\bCLUSTER\b|\bREINDEX\b(?!\s+CONCURRENTLY)/i,
    risk: 'locks-writes',
    what: () => 'rewrites the table or index while holding an exclusive lock on it',
    instead: 'run it in a maintenance window, or use the CONCURRENTLY form where the database offers one',
  },
  {
    find: new RegExp(String.raw`\bUPDATE\s+(${NAME})\s+SET\b(?![\s\S]*\bWHERE\b)`, 'i'),
    risk: 'slow',
    what: (m) => `updates every row of ${bare(m[1])} in one statement`,
    instead: 'update in batches with a WHERE on the primary key. One statement over a large table holds its locks and its transaction open until it finishes',
    table: (m) => bare(m[1]),
  },
  {
    find: new RegExp(String.raw`\bDELETE\s+FROM\s+(${NAME})\b(?![\s\S]*\bWHERE\b)`, 'i'),
    risk: 'destroys-data',
    what: (m) => `deletes every row of ${bare(m[1])}`,
    instead: 'say what should go with a WHERE, or keep the rows and stop reading them',
    table: (m) => bare(m[1]),
  },
];

/** `"users"` and `` `users` `` and `[users]` are all the table users. */
const bare = (name: string): string => name.replace(/["`[\]]/g, '').trim();

/** The statements of a SQL file, with the line each one starts on and comments removed. */
export function statementsOf(sql: string): Array<{ text: string; line: number }> {
  // Comments are blanked rather than removed, so every remaining character keeps its original position
  // and a statement can be reported on the line a reader will actually find it. Deleting them instead
  // shifted everything upwards: a statement on line 3 was reported as line 1.
  const blanked = sql
    .split(String.fromCharCode(10))
    .map((line) => line.replace(/--.*$/, (m) => ' '.repeat(m.length)))
    .join(String.fromCharCode(10))
    // A block comment keeps its newlines so later lines are still numbered correctly.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.split(String.fromCharCode(10)).map((l) => ' '.repeat(l.length)).join(String.fromCharCode(10)));

  const lineOf = (index: number): number => blanked.slice(0, index).split(String.fromCharCode(10)).length;
  const out: Array<{ text: string; line: number }> = [];
  let start = 0;
  for (let i = 0; i <= blanked.length; i += 1) {
    if (i < blanked.length && blanked[i] !== ';') continue;
    const segment = blanked.slice(start, i);
    const text = CLEAN(segment);
    if (text) {
      // Where the statement itself begins, not where the segment did.
      const offset = segment.length - segment.replace(/^\s+/, '').length;
      out.push({ text, line: lineOf(start + offset) });
    }
    start = i + 1;
  }
  return out;
}

/** What this one statement does, or nothing when it is not a statement worth a word. */
export function judge(statement: string, line: number): Finding | null {
  for (const rule of RULES) {
    const hit = rule.find.exec(statement);
    if (!hit) continue;
    return {
      statement: statement.slice(0, 300),
      line,
      risk: rule.risk,
      what: rule.what(hit),
      instead: rule.instead,
      table: rule.table?.(hit) ?? '',
      column: rule.column?.(hit) ?? '',
    };
  }
  return null;
}

/** Every finding in a SQL migration. */
export function readSql(sql: string): Finding[] {
  return statementsOf(sql)
    .map(({ text, line }) => judge(text, line))
    .filter((f): f is Finding => f !== null);
}
