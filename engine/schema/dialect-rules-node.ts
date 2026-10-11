// Phase 35: the migration tools whose words are Node, .NET and Java rather than Python or Ruby.
//
// Separated from dialect-rules.ts only because this project keeps every file under 300 lines, and
// adding these four pushed it over. They belong together for a better reason than size, though:
// all four were written against a real migration from a public repository - Matterwiki (Knex),
// opencollective-api (Sequelize), Coflnet/HypixelSkyblock (EF Core) and DEFRA/ffc-pay-processing
// (Liquibase) - and two of those four real files put their only destructive call in the rollback,
// which is what these ecosystems do as a matter of habit rather than by accident.
import type { Operation } from './dialect-rules.ts';

const STR = String.raw`['"]([\w.]+)['"]`;

/** Alembic. */
/**
 * Sequelize. `queryInterface.removeColumn('Users', 'passwordHash')` names the table and the column
 * in one call, which makes it the simplest of these to read.
 *
 * Written against opencollective-api's real migrations, which also show why the forward path
 * matters more here than anywhere else: a Sequelize migration almost always *adds* in `up` and
 * *removes* in `down`, so a reader that took the whole file would report every harmless migration
 * in the ecosystem as dropping a column.
 */
const SEQUELIZE: Operation[] = [
  {
    find: new RegExp(String.raw`removeColumn\s*\(\s*${STR}\s*,\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `removes ${m[1]}.${m[2]}`,
    instead: 'deploy code that no longer selects or writes the column, then remove it in a later migration',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`renameColumn\s*\(\s*${STR}\s*,\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames ${m[1]}.${m[2]}`,
    instead: 'add the new column, write to both, move the readers, then remove the old one',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`dropTable\s*\(\s*${STR}`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${m[1]}`,
    instead: 'stop reading the table, deploy that, then drop it once nothing refers to it',
    table: (m) => m[1],
  },
  {
    // Sequelize has no CONCURRENTLY option, so an index on a populated table takes the lock.
    find: new RegExp(String.raw`addIndex\s*\(\s*${STR}`, 'i'),
    unless: /concurrently\s*:\s*true/i,
    risk: 'locks-writes',
    what: (m) => `builds an index on ${m[1]} while holding a lock that blocks writes to it`,
    instead: 'build it concurrently with a raw query, or accept the lock if the table is small',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`changeColumn\s*\(\s*${STR}\s*,\s*${STR}`, 'i'),
    risk: 'locks-writes',
    what: (m) => `changes the type of ${m[1]}.${m[2]}, which can rewrite the whole table`,
    instead: 'add a new column, backfill it in batches, and switch the readers over',
    table: (m) => m[1],
    column: (m) => m[2],
  },
];

/**
 * Knex. The awkward one: the table is named by `knex.schema.table('articles', ...)` and the
 * operation happens inside the callback, so the two are matched together across the lines between
 * them. Matterwiki's real migrations are exactly this shape.
 */
const KNEX: Operation[] = [
  {
    find: new RegExp(String.raw`\.(?:table|alterTable)\s*\(\s*${STR}[\s\S]{0,400}?\.dropColumn\s*\(\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `drops ${m[1]}.${m[2]}`,
    instead: 'deploy code that no longer selects or writes the column, then drop it in a later migration',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`\.(?:table|alterTable)\s*\(\s*${STR}[\s\S]{0,400}?\.renameColumn\s*\(\s*${STR}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames ${m[1]}.${m[2]}`,
    instead: 'add the new column, write to both, move the readers, then remove the old one',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`\.dropTable(?:IfExists)?\s*\(\s*${STR}`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${m[1]}`,
    instead: 'stop reading the table, deploy that, then drop it once nothing refers to it',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`\.(?:table|alterTable)\s*\(\s*${STR}[\s\S]{0,400}?\.notNullable\s*\(`, 'i'),
    risk: 'locks-writes',
    what: (m) => `makes a column on ${m[1]} NOT NULL, which scans every row under a lock`,
    instead: 'add a CHECK ... NOT VALID, validate it, then set NOT NULL - or accept the scan if the table is small',
    table: (m) => m[1],
  },
];

/**
 * EF Core. Its MigrationBuilder calls use named arguments over several lines and in either order,
 * so each operation is matched twice - once for `name` before `table`, once for the reverse -
 * rather than assuming the order Coflnet's real migrations happen to use.
 */
const NAMED = (first: string, second: string) =>
  String.raw`(?:${first}:\s*${STR}[\s\S]{0,200}?${second}:\s*${STR}|${second}:\s*${STR}[\s\S]{0,200}?${first}:\s*${STR})`;
/** Whichever order the arguments came in, the two names are in 1,2 or in 4,3. */
const pair = (m: RegExpExecArray): [string, string] => (m[1] !== undefined ? [m[1], m[2]] : [m[4], m[3]]);

const EFCORE: Operation[] = [
  {
    find: new RegExp(String.raw`migrationBuilder\.DropColumn\s*\(\s*${NAMED('name', 'table')}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `drops ${pair(m)[1]}.${pair(m)[0]}`,
    instead: 'deploy code that no longer selects or writes the column, then drop it in a later migration',
    table: (m) => pair(m)[1],
    column: (m) => pair(m)[0],
  },
  {
    find: new RegExp(String.raw`migrationBuilder\.DropTable\s*\(\s*name:\s*${STR}`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${m[1]}`,
    instead: 'stop reading the table, deploy that, then drop it once nothing refers to it',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`migrationBuilder\.RenameColumn\s*\(\s*${NAMED('name', 'table')}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames ${pair(m)[1]}.${pair(m)[0]}`,
    instead: 'add the new column, write to both, move the readers, then remove the old one',
    table: (m) => pair(m)[1],
    column: (m) => pair(m)[0],
  },
  {
    find: new RegExp(String.raw`migrationBuilder\.CreateIndex\s*\(\s*${NAMED('name', 'table')}`, 'i'),
    risk: 'locks-writes',
    what: (m) => `builds an index on ${pair(m)[1]} while holding a lock that blocks writes to it`,
    instead: 'build it concurrently with migrationBuilder.Sql, or accept the lock if the table is small',
    table: (m) => pair(m)[1],
  },
  {
    find: new RegExp(String.raw`migrationBuilder\.AlterColumn<[^>]*>\s*\(\s*${NAMED('name', 'table')}`, 'i'),
    risk: 'locks-writes',
    what: (m) => `alters ${pair(m)[1]}.${pair(m)[0]}, which can rewrite the whole table`,
    instead: 'add a new column, backfill it in batches, and switch the readers over',
    table: (m) => pair(m)[1],
    column: (m) => pair(m)[0],
  },
];

/**
 * Liquibase. A changelog is XML or YAML rather than code, and the operation is the element name
 * with the table on `tableName`. DEFRA's real changelogs are the shape this was written against.
 */
const XML_TABLE = String.raw`tableName\s*=\s*["']([\w.]+)["']`;
const LIQUIBASE: Operation[] = [
  {
    find: new RegExp(String.raw`<dropColumn[^>]*${XML_TABLE}[\s\S]{0,300}?<column[^>]*name\s*=\s*["']([\w.]+)["']`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `drops ${m[1]}.${m[2]}`,
    instead: 'deploy code that no longer selects or writes the column, then drop it in a later changeSet',
    table: (m) => m[1],
    column: (m) => m[2],
  },
  {
    find: new RegExp(String.raw`<dropColumn[^>]*columnName\s*=\s*["']([\w.]+)["'][^>]*${XML_TABLE}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `drops ${m[2]}.${m[1]}`,
    instead: 'deploy code that no longer selects or writes the column, then drop it in a later changeSet',
    table: (m) => m[2],
    column: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`<dropTable[^>]*${XML_TABLE}`, 'i'),
    risk: 'destroys-data',
    what: (m) => `drops the table ${m[1]}`,
    instead: 'stop reading the table, deploy that, then drop it once nothing refers to it',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`<renameColumn[^>]*${XML_TABLE}`, 'i'),
    risk: 'breaks-old-code',
    what: (m) => `renames a column on ${m[1]}`,
    instead: 'add the new column, write to both, move the readers, then remove the old one',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`<addNotNullConstraint[^>]*${XML_TABLE}`, 'i'),
    risk: 'locks-writes',
    what: (m) => `makes a column on ${m[1]} NOT NULL, which scans every row under a lock`,
    instead: 'add a CHECK ... NOT VALID, validate it, then set NOT NULL - or accept the scan if the table is small',
    table: (m) => m[1],
  },
  {
    find: new RegExp(String.raw`<createIndex[^>]*${XML_TABLE}`, 'i'),
    risk: 'locks-writes',
    what: (m) => `builds an index on ${m[1]} while holding a lock that blocks writes to it`,
    instead: 'build it concurrently with a <sql> changeSet, or accept the lock if the table is small',
    table: (m) => m[1],
  },
];

export { SEQUELIZE, KNEX, EFCORE, LIQUIBASE };
