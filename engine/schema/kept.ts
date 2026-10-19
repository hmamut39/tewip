// What a migration takes away and then gives straight back.
//
// Split out of schema-command.ts when it passed this project's 300-line rule. Everything here
// answers one question - is this finding a loss, or is it scaffolding the same migration undoes a
// few statements later - and the answer is always no finding rather than a quieter one.
import type { Finding, Risk } from './statements.ts';

/**
 * Tables this migration creates itself.
 *
 * A lock is only expensive because of the rows it holds up, and a table created three statements
 * earlier has none. This matters enormously on the tools that generate their SQL: a Prisma project
 * emits `CREATE TABLE` followed by an `ADD CONSTRAINT ... FOREIGN KEY` for every relation, so
 * documenso's 165 real migrations produced 275 "blocks writes while it runs" findings - 1.7 per
 * migration, nearly all of them about tables that did not exist a moment before. That is the volume
 * at which a team stops reading the report, which costs more than the warnings are worth.
 */
function createdHere(text: string): Set<string> {
  const names = new Set<string>();
  // The frameworks say "create this table" in their own words, and the suppression is worth nothing
  // in a dialect it cannot read. Only SQL was read, so bitwarden/server's 456 EF Core migrations -
  // which do exactly what Prisma does, a CreateTable followed by a CreateIndex for every relation -
  // produced 647 "blocks writes" findings about tables that had not existed a statement earlier.
  // EF Core puts the name on the line after the call, so these have to reach across a newline.
  const FRAMEWORK_CREATES = [
    /migrationBuilder\s*\.\s*CreateTable\s*\([\s\S]{0,80}?name\s*:\s*["']([\w$.]+)["']/gi,
    // Django names the model rather than the table, and so does its AddIndex, so the two match each
    // other. Saleor never exercises this - Django convention puts CreateModel and AddIndex in
    // separate migrations - but every other dialect here has its create form registered and this
    // one did not, which is the kind of gap that waits for a project with different habits.
    /migrations\s*\.\s*CreateModel\s*\([\s\S]{0,60}?name\s*=\s*["']([\w]+)["']/gi,
    /queryInterface\s*\.\s*createTable\s*\(\s*["']([\w$.]+)["']/gi,
    /knex\s*\.\s*schema\s*\.\s*createTable\s*\(\s*["']([\w$.]+)["']/gi,
    /Schema\s*::\s*create\s*\(\s*["']([\w$.]+)["']/gi,
    /\bcreate_table\s+[:'"]([\w$.]+)/gi,
    /\bop\s*\.\s*create_table\s*\(\s*["']([\w$.]+)["']/gi,
    /<createTable[^>]*tableName\s*=\s*["']([\w$.]+)["']/gi,
  ];
  for (const pattern of FRAMEWORK_CREATES)
    for (const m of text.matchAll(pattern)) names.add(m[1].toLowerCase().replace(/^.*\./, ''));
  // Every dialect's way of quoting a name, because the suppression is useless in the one that does
  // not match. This read PostgreSQL's "quoted" form and plain names, and not SQL Server's
  // [dbo].[Grant] - which is standard T-SQL and what bitwarden/server is written in throughout. No
  // table was ever recognised as freshly created there, so every index built on a table created two
  // statements earlier was reported as blocking writes: 714 findings, nearly all of them free.
  for (const m of text.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w$.\"\[\]`]+)/gi)) {
    // `[dbo].[Grant]` and `"public"."grant"` and `grant` all have to arrive here as the same word,
    // because that is the form the findings report a table in.
    names.add(m[1].replace(/[\"\[\]`]/g, '').toLowerCase().replace(/^.*\./, ''));
  }
  return names;
}

/** Risks that are only risks because rows already exist. */
const ONLY_HURTS_EXISTING_ROWS = new Set<Risk>(['locks-writes', 'slow']);

/**
 * Tables that something is renamed *to* in this migration.
 *
 * SQLite cannot alter a column, so the way to change one is to build a new table, copy every row
 * into it, drop the original and rename the copy into its place. TypeORM generates exactly that,
 * automatically, for every column change on SQLite, and n8n's migrations are full of it:
 *
 *     CREATE TABLE temporary_credentials_entity (...)
 *     INSERT INTO temporary_credentials_entity SELECT ... FROM credentials_entity
 *     DROP TABLE credentials_entity
 *     ALTER TABLE temporary_credentials_entity RENAME TO credentials_entity
 *
 * The drop is real and the table is gone for an instant, but nothing is lost: the rows were copied
 * first and the name is given straight back. Calling that "drops the table credentials_entity and
 * everything in it" is wrong, and it would be wrong on nearly every TypeORM migration ever
 * generated for SQLite.
 */
function renamedInto(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\bRENAME\s+TO\s+([\w."'`$[\]{}]+)/gi)) {
    names.add(m[1].replace(/\$\{[^}]*\}/g, '').replace(/["'`[\]]/g, '').toLowerCase().replace(/^.*\./, ''));
  }
  return names;
}

export function droppingWhatIsNew(findings: Finding[], text: string): Finding[] {
  const fresh = createdHere(text);
  const rebuilt = renamedInto(text);
  if (fresh.size === 0 && rebuilt.size === 0) return findings;
  const nameOf = (f: Finding) => f.table.toLowerCase().replace(/^.*\./, '');
  return findings.filter((f) => {
    if (ONLY_HURTS_EXISTING_ROWS.has(f.risk) && fresh.has(nameOf(f))) return false;
    // A table dropped and immediately given its name back by a rename is a rebuild, not a loss.
    if (f.risk === 'destroys-data' && rebuilt.has(nameOf(f))) return false;
    return true;
  });
}
