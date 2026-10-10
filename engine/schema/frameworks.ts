// The same schema changes, written in a framework's own words.
//
// Most migrations in the world are not SQL files. They are Django's `migrations.RemoveField`, Rails's
// `remove_column`, Alembic's `op.drop_column` - and each of those produces exactly the DDL that causes
// the outage. A tool that only reads `.sql` would be blind in most of the repositories it is pointed at,
// so the operations are recognised in each framework's spelling and judged the same way.
//
// Only what can be read plainly is judged. A migration that builds its SQL in a loop, or calls out to
// application code, is reported as unread rather than cleared - the same rule as everywhere else here.
import type { Finding, Risk } from './statements.ts';

export type Dialect = 'sql' | 'django' | 'rails' | 'alembic' | 'unknown';

export function dialectOf(file: string, text: string): Dialect {
  const path = file.split('\\').join('/').toLowerCase();
  if (path.endsWith('.sql')) return 'sql';
  // `class Migration(migrations.Migration)` is what makes a file a Django migration. Keying only on the
  // operation names left Zulip's data migrations unread - and a data migration is exactly the kind that
  // runs for an hour with a transaction held open.
  if (/\bmigrations\.Migration\b|\bmigrations\.(?:CreateModel|AddField|RemoveField|AlterField|RenameField|RunSQL|RunPython|DeleteModel|RenameModel)\b/.test(text)) return 'django';
  if (/\bActiveRecord::Migration\b|\bdef\s+(?:up|change)\b[\s\S]*\b(?:add_column|remove_column|add_index|change_column|rename_column|drop_table)\b/.test(text)) return 'rails';
  if (/\bop\.(?:drop_column|add_column|create_index|alter_column|drop_table|rename_table|execute)\b/.test(text)) return 'alembic';
  if (/(^|\/)(migrations?|db\/migrate)\//.test(path)) return 'unknown';
  return 'unknown';
}

interface Operation {
  find: RegExp;
  /**
   * The migration already does the safe thing, so there is nothing to report.
   *
   * This is where the precision of the whole feature lives. Zulip's data migrations set `atomic = False`
   * and batch their work - exactly what the advice says to do - and the first run told them to do it
   * anyway. A tool that lectures a careful team about something they already handled is a tool they turn
   * off, so a guard that is visible in the file counts.
   */
  unless?: RegExp;
  risk: Risk;
  what: (m: RegExpExecArray) => string;
  instead: string;
  table?: (m: RegExpExecArray) => string;
  column?: (m: RegExpExecArray) => string;
}

const STR = String.raw`['"]([\w.]+)['"]`;

/** Django's operations. `model_name` and `name` are the table and the column. */
const DJANGO: Operation[] = [
  {
    find: new RegExp(String.raw`migrations\.RemoveField\([\s\S]{0,200}?model_name=${STR}[\s\S]{0,200}?name=${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `removes the field ${m[2]} from ${m[1]}`,
    instead: 'stop reading and writing the field, deploy that, then remove it in a later migration. The version still running during a rolling deploy will select a column that no longer exists',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`migrations\.RenameField\([\s\S]{0,200}?model_name=${STR}[\s\S]{0,200}?old_name=${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames ${m[1]}.${m[2]}`,
    instead: 'add the new field, write to both, move the readers, then remove the old one',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`migrations\.DeleteModel\([\s\S]{0,120}?${STR}`, 'i'),
    risk: 'destroys-data',
    what: (m) => `deletes the model ${m[1]} and its table`,
    instead: 'stop using it, ship that, confirm nothing reads it, and delete it later',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`migrations\.AddField\([\s\S]{0,400}?null=False(?![\s\S]{0,400}?default=)`, 'i'),
    risk: 'breaks-old-code',
    what: () => 'adds a field that cannot be null and has no default',
    instead: 'add it with null=True or a default. Without one, Django rewrites the table and every insert from the running version fails',
  },
  {
    find: new RegExp(String.raw`migrations\.AlterField\([\s\S]{0,400}?null=False`, 'i'),
    risk: 'locks-writes',
    what: () => 'makes an existing field NOT NULL, which reads every row under a lock',
    instead: 'backfill first, add a validated constraint, then alter - or use SeparateDatabaseAndState with the safe SQL',
  },
  {
    // A data migration. Django wraps a migration in one transaction, so this holds it open for as long as
    // the work takes - fine for a hundred rows, an outage for a hundred million.
    find: /migrations\.RunPython\(/,
    unless: /atomic\s*=\s*False/,
    risk: 'slow',
    what: () => 'runs application code against the data inside the migration transaction',
    instead: 'for a large table, work in batches with atomic = False on the migration and make it resumable. For a small one this is fine - Tewip cannot see how many rows there are',
  },
  {
    find: /AddIndex\(|AddConstraint\(/i,
    unless: /AddIndexConcurrently|AddConstraintNotValid|atomic\s*=\s*False/,
    risk: 'locks-writes',
    what: () => 'adds an index or constraint, which Django builds with a lock unless told otherwise',
    instead: 'AddIndexConcurrently / AddConstraintNotValid from django.contrib.postgres.operations, with atomic = False on the migration',
  },
];

/** Rails migrations. */
const RAILS: Operation[] = [
  {
    find: new RegExp(String.raw`remove_column\s*[\s(]\s*:?(\w+)\s*,\s*:?(\w+)`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `removes ${m[1]}.${m[2]}`,
    instead: "ignore the column in the model (self.ignored_columns), deploy that, then remove it. Rails caches the column list, so the running version keeps selecting it",
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`rename_column\s*[\s(]\s*:?(\w+)\s*,\s*:?(\w+)`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames ${m[1]}.${m[2]}`,
    instead: 'add the new column, write to both, move the readers, then remove the old one',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`drop_table\s*[\s(]\s*:?(\w+)`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${m[1]}`,
    instead: 'stop using it, ship that, then drop it later',
    table: (m) => m[1],
  },
  {
    find: /add_index\s*[\s(]/i,
    unless: /algorithm:\s*:concurrently/,
    risk: 'locks-writes',
    what: () => 'adds an index without algorithm: :concurrently, so writes to the table block while it builds',
    instead: 'add_index ..., algorithm: :concurrently, with disable_ddl_transaction! on the migration',
  },
  {
    find: new RegExp(String.raw`change_column\s*[\s(]\s*:?(\w+)\s*,\s*:?(\w+)`, 'i'),
    risk: 'locks-writes',
    what: (m) => `changes the type of ${m[1]}.${m[2]}, which usually rewrites the table`,
    instead: 'add a new column, backfill in batches, switch the readers, then drop the old one',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`change_column_null\s*[\s(]\s*:?(\w+)\s*,\s*:?(\w+)\s*,\s*false`, 'i'),
    risk: 'locks-writes',
    what: (m) => `makes ${m[1]}.${m[2]} NOT NULL, which reads every row under a lock`,
    instead: 'add a validated check constraint first, then set the column NOT NULL',
    table: (m) => m[1],
    column: (m) => m[2],
  },
];

/** Alembic. */
const ALEMBIC: Operation[] = [
  {
    find: new RegExp(String.raw`op\.drop_column\(\s*${STR}\s*,\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `drops ${m[1]}.${m[2]}`,
    instead: 'stop reading and writing it, deploy that, then drop it in a later revision',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`op\.drop_table\(\s*${STR}`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${m[1]}`,
    instead: 'stop using it, ship that, then drop it later',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`op\.alter_column\([\s\S]{0,300}?nullable=False`, 'i'),
    risk: 'locks-writes',
    what: () => 'makes a column NOT NULL, which reads every row under a lock',
    instead: 'backfill, add a validated constraint, then alter the column',
  },
  {
    find: /op\.create_index\(/i,
    unless: /postgresql_concurrently\s*=\s*True/,
    risk: 'locks-writes',
    what: () => 'builds an index without postgresql_concurrently, so writes block while it builds',
    instead: 'op.create_index(..., postgresql_concurrently=True) with a non-transactional revision',
  },
  {
    find: new RegExp(String.raw`op\.rename_table\(\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames the table ${m[1]}`,
    instead: 'move the readers first, or keep a view with the old name',
    table: (m) => m[1],
  },
];

const BY_DIALECT: Record<Exclude<Dialect, 'sql' | 'unknown'>, Operation[]> = { django: DJANGO, rails: RAILS, alembic: ALEMBIC };

/** Findings from a framework migration, with the line each one sits on. */
export function readFramework(dialect: Exclude<Dialect, 'sql' | 'unknown'>, text: string): Finding[] {
  const lines = text.split(String.fromCharCode(10));
  const out: Finding[] = [];
  for (const operation of BY_DIALECT[dialect]) {
    const hit = operation.find.exec(text);
    if (!hit) continue;
    if (operation.unless?.test(text)) continue;
    // The line the match starts on, so the reader can go straight to it.
    const before = text.slice(0, hit.index ?? 0).split(String.fromCharCode(10)).length;
    out.push({
      statement: (lines[before - 1] ?? hit[0]).trim().slice(0, 300),
      line: before,
      risk: operation.risk,
      what: operation.what(hit),
      instead: operation.instead,
      table: operation.table?.(hit) ?? '',
      column: operation.column?.(hit) ?? '',
    });
  }
  return out;
}

/** A migration that cannot be rolled back by running its own down step. */
export function irreversible(dialect: Dialect, text: string): boolean {
  if (dialect === 'django') return /migrations\.RunPython\([^)]*\)/.test(text) && !/reverse_code|RunPython\.noop/.test(text);
  if (dialect === 'alembic') return /def\s+downgrade\(\)[\s\S]{0,120}?(?:pass|raise\s+NotImplementedError)/.test(text);
  if (dialect === 'rails') return /\braise\s+ActiveRecord::IrreversibleMigration\b/.test(text);
  return false;
}

/**
 * The forward path only, with the rollback blanked out.
 *
 * A migration's `down` step is what runs if the change is undone, and it necessarily contains the mirror
 * image of the change - a drop_table for a create_table, a remove_column for an add_column. Reading it as
 * part of the change produces exactly the wrong answer, and Mastodon's own migration proved it: a file
 * that creates a table was reported as destroying one, because its rollback drops it.
 *
 * The region is blanked rather than removed so every remaining line keeps its number.
 */
export function forwardOnly(dialect: Dialect, text: string): string {
  const lines = text.split(String.fromCharCode(10));
  const blankFrom = (start: number, until: (line: string, indent: number) => boolean, indent: number): void => {
    for (let i = start; i < lines.length; i += 1) {
      if (i > start && until(lines[i], indent)) return;
      lines[i] = '';
    }
  };
  const indentOf = (line: string) => line.length - line.trimStart().length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const down =
      (dialect === 'rails' && /^\s*def\s+down\b/.test(line)) ||
      (dialect === 'alembic' && /^\s*def\s+downgrade\s*\(/.test(line)) ||
      (dialect === 'sql' && /^\s*--\s*(?:\+migrate\s+Down|\+goose\s+Down|\/\/@UNDO|Down\b)/i.test(line));
    if (down) {
      // To the end of the block: the next line at the same indentation or less that starts something new.
      blankFrom(i, (l, indent) => l.trim() !== '' && indentOf(l) <= indent && !/^\s*(end|\})\s*$/.test(l), indentOf(line));
      continue;
    }
    // Rails's `direction.down { ... }` is usually one line.
    if (dialect === 'rails' && /direction\.down\b/.test(line)) lines[i] = '';
  }
  return lines.join(String.fromCharCode(10));
}
