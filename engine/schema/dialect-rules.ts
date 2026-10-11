// Phase 26 and after: what each migration framework calls the operations that cause an outage.
//
// Split out of frameworks.ts, which passed this project's 300-line rule when Sequelize, Knex, EF Core
// and Liquibase were added. The split is along the natural seam: this file is the catalogue of what
// each tool's words mean, and frameworks.ts is the machinery that decides which tool wrote a file,
// strips its rollback, and runs the catalogue over what is left.
//
// Every table here was written against a real migration from a public repository rather than from a
// remembered API, which is the only reason several of them are right.
import type { Finding, Risk } from './statements.ts';

export interface Operation {
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

// TypeORM has no operations of its own: unlike Django's `RemoveField` or Rails's `remove_column`,
// a TypeORM migration contains SQL and nothing else, handed to queryRunner.query(). So its list is
// empty on purpose and every finding comes from reading that SQL, which is the same reader the
// `.sql` dialect uses. The exhaustive Record is what made this a compile error rather than a
// TypeORM migration silently producing no findings at all.


/**
 * Laravel. Found missing by running Tewip over firefly-iii, a real finance application with **61
 * migrations Tewip could not read a word of** - and Laravel is one of the most used web frameworks
 * there is, while `schema` advertised nine dialects.
 *
 * Structurally it is Knex's shape: the table is named by `Schema::table('accounts', ...)` and the
 * operation happens inside the closure, so the two are matched together across the lines between.
 */
export const LARAVEL: Operation[] = [
  {
    find: new RegExp(String.raw`Schema::(?:table|connection\(.*?\)->table)\(\s*${STR}[\s\S]{0,600}?->dropColumn\(\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `drops ${m[1]}.${m[2]}`,
    instead: 'deploy code that no longer selects or writes the column, then drop it in a later migration. Eloquent caches the column list, so the running version keeps selecting it',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`Schema::(?:table|connection\(.*?\)->table)\(\s*${STR}[\s\S]{0,600}?->renameColumn\(\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames ${m[1]}.${m[2]}`,
    instead: 'add the new column, write to both, move the readers, then remove the old one',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`Schema::drop(?:IfExists)?\(\s*${STR}`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${m[1]}`,
    instead: 'stop reading the table, deploy that, then drop it once nothing refers to it',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`Schema::(?:table|connection\(.*?\)->table)\(\s*${STR}[\s\S]{0,600}?->index\(`, 'i'),
    risk: 'locks-writes',
    what: (m) => `builds an index on ${m[1]} while holding a lock that blocks writes to it`,
    instead: 'build it with a raw CREATE INDEX CONCURRENTLY through DB::statement, or accept the lock if the table is small',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`Schema::(?:table|connection\(.*?\)->table)\(\s*${STR}[\s\S]{0,600}?->foreign\(`, 'i'),
    risk: 'locks-writes',
    what: (m) => `adds a foreign key to ${m[1]}, which checks every existing row under a lock on both tables`,
    instead: 'add it NOT VALID and validate it afterwards, which takes a weaker lock',
    table: (m) => m[1],
  },
];

export { DJANGO, RAILS, ALEMBIC };
