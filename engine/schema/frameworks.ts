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
import { ALEMBIC, DJANGO, LARAVEL, RAILS, type Operation } from './dialect-rules.ts';
import { EFCORE, KNEX, LIQUIBASE, SEQUELIZE } from './dialect-rules-node.ts';

export type Dialect = 'sql' | 'django' | 'rails' | 'alembic' | 'typeorm' | 'sequelize' | 'knex' | 'efcore' | 'liquibase' | 'laravel' | 'unknown';

export function dialectOf(file: string, text: string): Dialect {
  const path = file.split('\\').join('/').toLowerCase();
  if (path.endsWith('.sql')) return 'sql';
  // `class Migration(migrations.Migration)` is what makes a file a Django migration. Keying only on the
  // operation names left Zulip's data migrations unread - and a data migration is exactly the kind that
  // runs for an hour with a transaction held open.
  if (/\bmigrations\.Migration\b|\bmigrations\.(?:CreateModel|AddField|RemoveField|AlterField|RenameField|RunSQL|RunPython|DeleteModel|RenameModel)\b/.test(text)) return 'django';
  if (/\bActiveRecord::Migration\b|\bdef\s+(?:up|change)\b[\s\S]*\b(?:add_column|remove_column|add_index|change_column|rename_column|drop_table)\b/.test(text)) return 'rails';
  if (/\bop\.(?:drop_column|add_column|create_index|alter_column|drop_table|rename_table|execute)\b/.test(text)) return 'alembic';
  // TypeORM writes a migration as a class with up() and down(), and puts the real DDL in template
  // strings passed to queryRunner.query(). The SQL is right there and perfectly readable; only the
  // wrapper was unfamiliar, so every TypeORM project was told Tewip could not read its migrations
  // at all - and on a Node backend that is most of them.
  // Laravel, before the generic checks: its migrations are PHP and would otherwise fall through
  // to 'unknown'. firefly-iii has 61 of them and Tewip could not read a word.
  if (/Illuminate.Database.Migrations.Migration|\bSchema::(?:table|create|drop|dropIfExists|connection)\s*\(/.test(text)) return 'laravel';
  if (/\bMigrationInterface\b|\bqueryRunner\.query\s*\(/.test(text)) return 'typeorm';
  if (/\bqueryInterface\.\w+\s*\(/.test(text)) return 'sequelize';
  if (/\bknex\.schema\b|\bexports\.(?:up|down)\s*=\s*(?:async\s*)?function\s*\(\s*knex\b/.test(text)) return 'knex';
  if (/\bmigrationBuilder\.\w+|\b:\s*Migration\b[\s\S]*\bMigrationBuilder\b/.test(text)) return 'efcore';
  if (/<databaseChangeLog\b|\bdatabaseChangeLog\s*:/.test(text)) return 'liquibase';
  if (/(^|\/)(migrations?|db\/migrate)\//.test(path)) return 'unknown';
  return 'unknown';
}

const BY_DIALECT: Record<Exclude<Dialect, 'sql' | 'unknown'>, Operation[]> = {
  django: DJANGO,
  rails: RAILS,
  alembic: ALEMBIC,
  typeorm: [],
  sequelize: SEQUELIZE,
  knex: KNEX,
  efcore: EFCORE,
  liquibase: LIQUIBASE,
  laravel: LARAVEL,
};

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
      (dialect === 'sql' && /^\s*--\s*(?:\+migrate\s+Down|\+goose\s+Down|\/\/@UNDO|Down\b)/i.test(line)) ||
      // TypeORM's rollback is `public async down(queryRunner: QueryRunner)`. Reading it as part of
      // the change would report a migration that adds a column as one that drops it.
      (dialect === 'typeorm' && /^\s*(?:public\s+)?async\s+down\s*\(/.test(line)) ||
      // These three matter more than the rest. A Sequelize or Knex migration almost always *adds*
      // in up and *removes* in down, and an EF Core Down() is the mirror image of its Up(), so a
      // reader that took the whole file would report nearly every harmless migration in those
      // ecosystems as dropping a column. Verified on real migrations from opencollective-api,
      // Matterwiki and Coflnet, all three of which have their only destructive call in down.
      (dialect === 'sequelize' && /^\s*down\s*:/.test(line)) ||
      (dialect === 'knex' && /^\s*(?:exports\.down|module\.exports\.down)\s*=/.test(line)) ||
      (dialect === 'efcore' && /^\s*protected\s+override\s+void\s+Down\s*\(/.test(line)) ||
      // Laravel's rollback, which in real files often comes *before* up().
      (dialect === 'laravel' && /^\s*(?:public\s+)?function\s+down\s*\(/.test(line)) ||
      // Liquibase puts the reverse inside the change itself rather than in a second method.
      (dialect === 'liquibase' && /^\s*<rollback\b/.test(line));
    if (down) {
      // To the end of the block: the next line at the same indentation or less that starts something new.
      // A lone brace is punctuation, not the start of something new. C# puts the opening `{` of a
      // method on its own line at the same indent as the signature, so without `{` here the block
      // ended one line after it began and the whole of EF Core's Down() was read as part of the
      // change - which reported Coflnet's real migration as dropping three columns it adds.
      blankFrom(i, (l, indent) => l.trim() !== '' && indentOf(l) <= indent && !/^\s*(end|\}|\{)\s*$/.test(l), indentOf(line));
      continue;
    }
    // Rails's `direction.down { ... }` is usually one line.
    if (dialect === 'rails' && /direction\.down\b/.test(line)) lines[i] = '';
  }
  return lines.join(String.fromCharCode(10));
}
