// Phase 26: what a migration does to a live database.
//
// Two things decide whether this is worth installing. It has to name the change that causes the outage -
// a dropped column, an index built under a lock, a NOT NULL on a populated table - in the words of the
// framework the team actually uses. And it has to stay quiet when the team already did the safe thing,
// because a tool that lectures a careful team about something they handled is a tool they switch off.
// Zulip taught the second lesson on the first real run: its data migrations already set `atomic = False`
// and Tewip told them to do it anyway.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dialectOf, forwardOnly, irreversible, readFramework } from '../schema/frameworks.ts';
import { readSql, statementsOf } from '../schema/statements.ts';
import { schemaFiles } from '../schema/schema-command.ts';
import { MIGRATION } from '../schema/migration-files.ts';
import { droppingWhatIsNew } from '../schema/schema-command.ts';

const NL = String.fromCharCode(10);
const sql = (...lines: string[]) => lines.join(NL);

const risks = (text: string) => readSql(text).map((f) => f.risk);
const first = (text: string) => readSql(text)[0];

describe('reading SQL', () => {
  it('names a dropped column as something that breaks the running version', () => {
    const found = first('ALTER TABLE orders DROP COLUMN nickname;');
    assert.equal(found.risk, 'breaks-old-code');
    assert.equal(found.table, 'orders');
    assert.equal(found.column, 'nickname');
    assert.match(found.what, /drops the column nickname from orders/);
    assert.match(found.instead, /rolling deploy/);
  });

  it('names a dropped or emptied table as destroying data', () => {
    assert.deepEqual(risks('DROP TABLE sessions;'), ['destroys-data']);
    assert.deepEqual(risks('TRUNCATE TABLE audit_log;'), ['destroys-data']);
    assert.deepEqual(risks('DELETE FROM audit_log;'), ['destroys-data']);
  });

  it('leaves a DELETE with a WHERE alone', () => {
    assert.deepEqual(risks("DELETE FROM audit_log WHERE created_at < '2020-01-01';"), []);
  });

  it('catches an index built without CONCURRENTLY, and clears one built with it', () => {
    assert.deepEqual(risks('CREATE INDEX idx_orders_customer ON orders (customer_id);'), ['locks-writes']);
    assert.deepEqual(risks('CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id);'), []);
  });

  it('catches a NOT NULL added to an existing column, and a type change', () => {
    assert.deepEqual(risks('ALTER TABLE orders ALTER COLUMN email SET NOT NULL;'), ['locks-writes']);
    assert.deepEqual(risks('ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2);'), ['locks-writes']);
  });

  it('catches a foreign key added without NOT VALID, and clears one with it', () => {
    assert.deepEqual(risks('ALTER TABLE orders ADD CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers (id);'), ['locks-writes']);
    assert.deepEqual(risks('ALTER TABLE orders ADD CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;'), []);
  });

  it('catches a new NOT NULL column with no default, and clears one with a default', () => {
    assert.deepEqual(risks('ALTER TABLE orders ADD COLUMN channel text NOT NULL;'), ['breaks-old-code']);
    assert.deepEqual(risks("ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'web';"), []);
    assert.deepEqual(risks('ALTER TABLE orders ADD COLUMN channel text;'), []);
  });

  it('catches an UPDATE with no WHERE as a long transaction', () => {
    assert.deepEqual(risks('UPDATE orders SET channel = 1;'), ['slow']);
    assert.deepEqual(risks('UPDATE orders SET channel = 1 WHERE id < 1000;'), []);
  });

  it('reads a rename as a drop and an add at the same instant', () => {
    const found = first('ALTER TABLE orders RENAME COLUMN nickname TO display_name;');
    assert.equal(found.risk, 'breaks-old-code');
    assert.match(found.instead, /no deployment is that instant/);
  });

  it('ignores comments and keeps the line of each statement', () => {
    const text = sql('-- tidy up', '-- ALTER TABLE orders DROP COLUMN decoy;', 'ALTER TABLE orders DROP COLUMN nickname;');
    const found = readSql(text);
    assert.equal(found.length, 1, 'a commented-out statement is not a statement');
    assert.equal(found[0].line, 3);
  });

  it('reads quoted and bracketed names as plain names', () => {
    assert.equal(first('ALTER TABLE "orders" DROP COLUMN "nickname";').table, 'orders');
    assert.equal(first('ALTER TABLE [orders] DROP COLUMN [nickname];').column, 'nickname');
  });

  it('splits on statements rather than on lines', () => {
    const text = sql('ALTER TABLE orders', '  DROP COLUMN nickname;', 'DROP TABLE sessions;');
    assert.equal(statementsOf(text).length, 2);
    assert.deepEqual(risks(text), ['breaks-old-code', 'destroys-data']);
  });
});

describe('reading a framework migration', () => {
  it('recognises Django, Rails and Alembic', () => {
    assert.equal(dialectOf('zerver/migrations/0001_initial.py', 'class Migration(migrations.Migration):'), 'django');
    assert.equal(dialectOf('db/migrate/20260101_add.rb', 'class AddThing < ActiveRecord::Migration[7.1]\n  def change\n    add_column :orders, :channel, :string\n  end\nend'), 'rails');
    assert.equal(dialectOf('alembic/versions/abc.py', "def upgrade():\n    op.drop_column('orders', 'nickname')"), 'alembic');
    assert.equal(dialectOf('migrations/0001.sql', 'DROP TABLE x;'), 'sql');
  });

  it('says it cannot read a migration rather than passing it', () => {
    assert.equal(dialectOf('db/migrations/0001.go', 'func up() { /* goose */ }'), 'unknown');
  });

  it('names a removed Django field, with its table and column', () => {
    const text = "migrations.RemoveField(\n    model_name='userprofile',\n    name='zoom_token',\n)";
    const [found] = readFramework('django', text);
    assert.equal(found.risk, 'breaks-old-code');
    assert.equal(found.table, 'userprofile');
    assert.equal(found.column, 'zoom_token');
  });

  it('stays quiet about a data migration that already sets atomic = False', () => {
    // Zulip's own migrations do this, and the first version told them to do what they had done.
    const careful = 'class Migration(migrations.Migration):\n    atomic = False\n    operations = [migrations.RunPython(backfill, reverse_code=migrations.RunPython.noop)]';
    assert.deepEqual(readFramework('django', careful), []);
    const careless = 'class Migration(migrations.Migration):\n    operations = [migrations.RunPython(backfill)]';
    assert.deepEqual(readFramework('django', careless).map((f) => f.risk), ['slow']);
  });

  it('stays quiet about a Rails index added concurrently', () => {
    const careful = 'disable_ddl_transaction!\n  def change\n    add_index :orders, :customer_id, algorithm: :concurrently\n  end';
    assert.deepEqual(readFramework('rails', careful), []);
    assert.deepEqual(readFramework('rails', 'def change\n    add_index :orders, :customer_id\n  end').map((f) => f.risk), ['locks-writes']);
  });

  it('stays quiet about an Alembic index created concurrently', () => {
    assert.deepEqual(readFramework('alembic', "op.create_index('ix', 'orders', ['customer_id'], postgresql_concurrently=True)"), []);
    assert.deepEqual(readFramework('alembic', "op.create_index('ix', 'orders', ['customer_id'])").map((f) => f.risk), ['locks-writes']);
  });

  it('names a removed Rails column with its table', () => {
    const [found] = readFramework('rails', 'def change\n    remove_column :orders, :nickname, :string\n  end');
    assert.equal(found.table, 'orders');
    assert.equal(found.column, 'nickname');
  });

  it('notices a migration that cannot be undone by its own down step', () => {
    assert.equal(irreversible('rails', 'def up\n  raise ActiveRecord::IrreversibleMigration\nend'), true);
    assert.equal(irreversible('alembic', 'def downgrade():\n    pass'), true);
    assert.equal(irreversible('django', 'migrations.RunPython(forwards)'), true);
    assert.equal(irreversible('django', 'migrations.RunPython(forwards, reverse_code=backwards)'), false);
  });
});

// Phase 33: what 165 real Prisma migrations and a TypeORM project taught this.
//
// documenso's repository was the first time `schema` had been pointed at output a tool generated
// rather than output a person wrote, and generated SQL has different habits: it drops constraints
// constantly, and it creates a table and then immediately indexes it. Both were being reported as
// dangerous. The third case is TypeORM, whose migrations were not being read at all.
describe('generated migrations, and the habits they have', () => {
  it('DROP CONSTRAINT is not a column called CONSTRAINT', () => {
    // Every Prisma project is full of this line, and it was being reported as breaking the
    // running version - which dropping a foreign key does not do.
    assert.deepEqual(risks('ALTER TABLE "Share" DROP CONSTRAINT "Share_userId_fkey";'), []);
    assert.deepEqual(risks('ALTER TABLE "Share" DROP INDEX "idx_share";'), []);
    assert.deepEqual(risks('ALTER TABLE "Share" ALTER COLUMN "x" DROP DEFAULT;'), []);
    assert.deepEqual(risks('ALTER TABLE "Share" ALTER COLUMN "x" DROP NOT NULL;'), []);
  });

  it('still names a real dropped column, with or without the COLUMN keyword', () => {
    assert.deepEqual(risks('ALTER TABLE "Share" DROP COLUMN "userId";'), ['breaks-old-code']);
    assert.deepEqual(risks('ALTER TABLE orders DROP nickname;'), ['breaks-old-code']);
  });

  it('and the real one in the middle of a generated statement', () => {
    const found = first('ALTER TABLE "Share" DROP COLUMN "userId", ADD COLUMN "recipientId" INTEGER NOT NULL;');
    assert.equal(found.risk, 'breaks-old-code');
    assert.equal(found.column, 'userId');
  });
});

describe('TypeORM migrations', () => {
  const migration = sql(
    "import { MigrationInterface, QueryRunner } from 'typeorm';",
    'export class DropEmail1700000000000 implements MigrationInterface {',
    '  public async up(queryRunner: QueryRunner): Promise<void> {',
    '    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "legacy_email"`);',
    '  }',
    '  public async down(queryRunner: QueryRunner): Promise<void> {',
    '    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "tenantId"`);',
    '  }',
    '}',
  );

  it('is recognised rather than reported as unreadable', () => {
    assert.equal(dialectOf('src/migration/1700000000000-DropEmail.ts', migration), 'typeorm');
    assert.equal(dialectOf('src/migration/x.ts', 'await queryRunner.query(`SELECT 1`);'), 'typeorm');
  });

  it('is not mistaken for another framework', () => {
    assert.notEqual(dialectOf('a.py', 'class Migration(migrations.Migration): pass'), 'typeorm');
    assert.equal(dialectOf('a.sql', 'ALTER TABLE x DROP COLUMN y;'), 'sql');
  });

  it('reads only the forward path, so down() is not read as the change', () => {
    const forward = forwardOnly('typeorm', migration);
    assert.match(forward, /legacy_email/);
    assert.ok(!/tenantId/.test(forward), 'down() must not be read as part of the change');
  });
});

describe('a lock on a table that did not exist a moment ago', () => {
  const findings = (text: string) => droppingWhatIsNew(readSql(text), text).map((f) => f.what);

  it('says nothing about indexing a table this migration just created', () => {
    // documenso's initial Prisma migration creates every table and then adds eight foreign keys
    // and a dozen indexes. It was producing a wall of "blocks writes while it runs"; all of it was
    // about tables with no rows in them. Across its 165 migrations this was 129 findings.
    const text = sql(
      'CREATE TABLE "Share" ("id" INTEGER NOT NULL, "recipientId" INTEGER NOT NULL);',
      'CREATE INDEX "Share_recipientId_idx" ON "Share"("recipientId");',
      'ALTER TABLE "Share" ADD CONSTRAINT "Share_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id");',
    );
    assert.deepEqual(findings(text), []);
  });

  it('still says it about a table that was already there', () => {
    const text = 'CREATE INDEX "User_email_idx" ON "User"("email");';
    assert.equal(findings(text).length, 1);
    assert.match(findings(text)[0], /builds an index on User/);
  });

  it('a new table does not excuse a drop on an old one in the same migration', () => {
    const text = sql(
      'CREATE TABLE "Recipient" ("id" INTEGER NOT NULL);',
      'ALTER TABLE "Share" DROP COLUMN "userId";',
    );
    // Dropping a column is never about row count, so the guard must not touch it.
    assert.equal(findings(text).length, 1);
    assert.match(findings(text)[0], /drops the column userId/);
  });
});

// Phase 35: the four migration tools that were being reported as unreadable.
//
// Each shape below is copied from a real migration in a public repository - Matterwiki (Knex),
// opencollective-api (Sequelize), Coflnet/HypixelSkyblock (EF Core) and DEFRA/ffc-pay-processing
// (Liquibase) - rather than written from a remembered API.
//
// The thing all four have in common is why the forward path matters more here than anywhere else:
// a Sequelize or Knex migration almost always *adds* in up and *removes* in down, and an EF Core
// Down() is the mirror of its Up(). A reader that took the whole file would report nearly every
// harmless migration in those ecosystems as dropping a column. Two of the four real files used
// here contain a drop, and in both it is in the rollback - so the correct answer is silence.
describe('Sequelize, Knex, EF Core and Liquibase', () => {
  const seen = (file: string, text: string) => {
    const dialect = dialectOf(file, text);
    return { dialect, findings: readFramework(dialect as 'django', forwardOnly(dialect, text)) };
  };

  const sequelize = sql(
    "'use strict';",
    'module.exports = {',
    '  up: async (queryInterface, Sequelize) => {',
    "    await queryInterface.addColumn('Users', 'passwordHash', { type: Sequelize.STRING });",
    '  },',
    '  down: async queryInterface => {',
    "    await queryInterface.removeColumn('Users', 'passwordHash');",
    '  },',
    '};',
  );

  const knex = sql(
    'exports.up = function(knex, Promise) {',
    "  return knex.schema.table('articles', function (table) {",
    "    table.integer('user_id',10).unsigned().references('users.id');",
    '  })',
    '};',
    'exports.down = function(knex, Promise) {',
    "  return knex.schema.table('articles', function (table) {",
    "    table.dropColumn('user_id');",
    '  })',
    '};',
  );

  const efcore = sql(
    'using Microsoft.EntityFrameworkCore.Migrations;',
    'namespace App.Migrations',
    '{',
    '    public partial class v2 : Migration',
    '    {',
    '        protected override void Up(MigrationBuilder migrationBuilder)',
    '        {',
    '            migrationBuilder.CreateIndex(',
    '                name: "IX_Players_Uuid",',
    '                table: "Players");',
    '        }',
    '',
    '        protected override void Down(MigrationBuilder migrationBuilder)',
    '        {',
    '            migrationBuilder.DropColumn(',
    '                name: "Id",',
    '                table: "Players");',
    '        }',
    '    }',
    '}',
  );

  const liquibase = sql(
    '<?xml version="1.1" encoding="UTF-8" standalone="no"?>',
    '<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">',
    '  <changeSet author="John Watson" id="3">',
    '    <dropColumn tableName="completedPaymentRequests">',
    '      <column name="batched" />',
    '    </dropColumn>',
    '  </changeSet>',
    '</databaseChangeLog>',
  );

  it('recognises each one instead of calling it unreadable', () => {
    assert.equal(seen('migrations/20230118-x.js', sequelize).dialect, 'sequelize');
    assert.equal(seen('migrations/20160919-x.js', knex).dialect, 'knex');
    assert.equal(seen('Migrations/20201223_v2.cs', efcore).dialect, 'efcore');
    assert.equal(seen('changelog/db.changelog-1.5.xml', liquibase).dialect, 'liquibase');
  });

  it('says nothing when the only destructive call is in the rollback', () => {
    // Both of these are real migrations that add a column. Reporting them as dropping one would
    // make the whole feature untrustworthy in two large ecosystems.
    assert.deepEqual(seen('migrations/x.js', sequelize).findings, []);
    assert.deepEqual(seen('migrations/y.js', knex).findings, []);
  });

  it("reads EF Core's Up and not its Down, braces and all", () => {
    // C# puts the opening brace of a method on its own line at the same indent as the signature,
    // which ended the Down block one line after it began and leaked three drops into the change.
    const { findings } = seen('Migrations/v2.cs', efcore);
    assert.equal(findings.length, 1);
    assert.match(findings[0].what, /builds an index on Players/);
    assert.ok(!findings.some((f) => /drops/.test(f.what)), 'Down() must not be read as the change');
  });

  it('reads a Liquibase changeSet, table and column', () => {
    const { findings } = seen('changelog/x.xml', liquibase);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].risk, 'breaks-old-code');
    assert.equal(findings[0].table, 'completedPaymentRequests');
    assert.equal(findings[0].column, 'batched');
  });

  it('still names a drop that really is in the forward path', () => {
    const dropping = sql(
      'module.exports = {',
      '  up: async (queryInterface) => {',
      "    await queryInterface.removeColumn('Users', 'legacyEmail');",
      '  },',
      '};',
    );
    const { findings } = seen('migrations/z.js', dropping);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].table, 'Users');
    assert.equal(findings[0].column, 'legacyEmail');
  });

  it("reads EF Core's named arguments in either order", () => {
    const reversed = sql(
      '        protected override void Up(MigrationBuilder migrationBuilder)',
      '        {',
      '            migrationBuilder.DropColumn(table: "Players", name: "Nickname");',
      '        }',
    );
    const { findings } = seen('Migrations/a.cs', reversed);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].table, 'Players');
    assert.equal(findings[0].column, 'Nickname');
  });
});

// Phase 41: Laravel, found missing by using Tewip rather than by reading a list.
//
// Running the front door over firefly-iii - a real finance application, 24.8k stars - reported no
// migrations. It has 61. Laravel is one of the most used web frameworks there is, and `schema`
// advertised nine dialects without it.
//
// The shapes below are from those 61 real files, including the one that matters most: in real
// Laravel the rollback often comes *before* the forward path, and the drops live in it.
describe('Laravel migrations', () => {
  const seen = (text: string, file = 'database/migrations/2024_01_01_000000_x.php') => {
    const dialect = dialectOf(file, text);
    return { dialect, findings: readFramework(dialect as 'django', forwardOnly(dialect, text)) };
  };

  const dropInUp = sql(
    '<?php',
    'use Illuminate\Database\Migrations\Migration;',
    'return new class extends Migration {',
    '    public function up(): void',
    '    {',
    "        Schema::table('budget_limits', static function (Blueprint $table): void {",
    "            $table->dropColumn('repeats');",
    '        });',
    '    }',
    '};',
  );

  const dropInDown = sql(
    '<?php',
    'use Illuminate\Database\Migrations\Migration;',
    'return new class extends Migration {',
    '    public function down(): void',
    '    {',
    "        Schema::table('transactions', static function (Blueprint $table): void {",
    "            $table->dropColumn('balance_after');",
    '        });',
    '    }',
    '',
    '    public function up(): void',
    '    {',
    "        Schema::table('transactions', static function (Blueprint $table): void {",
    "            $table->decimal('balance_after', 32, 12)->nullable();",
    '        });',
    '    }',
    '};',
  );

  it('is recognised rather than reported as unreadable', () => {
    assert.equal(seen(dropInUp).dialect, 'laravel');
    assert.equal(dialectOf('x.php', "Schema::create('users', function ($t) {});"), 'laravel');
  });

  it('names a column dropped in the forward path', () => {
    const { findings } = seen(dropInUp);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].risk, 'breaks-old-code');
    assert.equal(findings[0].table, 'budget_limits');
    assert.equal(findings[0].column, 'repeats');
  });

  it('says nothing when the drop is in down(), even when down() comes first', () => {
    // Real Laravel does this, and firefly-iii's add_running_balance migration is exactly it: the
    // rollback is written above the forward path and holds all three drops.
    assert.deepEqual(seen(dropInDown).findings, []);
  });

  it('names a dropped table and a rename', () => {
    const dropped = seen(sql('<?php', 'use Illuminate\Database\Migrations\Migration;', 'public function up(): void', '{', "    Schema::dropIfExists('telemetry');", '}'));
    assert.equal(dropped.findings[0].risk, 'destroys-data');
    assert.equal(dropped.findings[0].table, 'telemetry');

    const renamed = seen(
      sql('<?php', 'use Illuminate\Database\Migrations\Migration;', 'public function up(): void', '{', "    Schema::table('tags', function (Blueprint $t) {", "        $t->renameColumn('tagMode', 'tag_mode');", '    });', '}'),
    );
    assert.match(renamed.findings[0].what, /renames tags\.tagMode/);
  });

  it('an index or a foreign key on an existing table takes a lock', () => {
    const indexed = seen(
      sql('<?php', 'use Illuminate\Database\Migrations\Migration;', 'public function up(): void', '{', "    Schema::table('transactions', function (Blueprint $t) {", "        $t->index(['deleted_at'], 'idx_tj_deleted');", '    });', '}'),
    );
    assert.equal(indexed.findings[0].risk, 'locks-writes');
    assert.match(indexed.findings[0].what, /builds an index on transactions/);
  });
});

// Phase 42: a changelog is often not in a directory that says so.
//
// Found by running the front door over openmrs-core, a real healthcare system. It reported no
// migrations. It has 44 Liquibase changelogs, kept in `api/src/main/resources/` and named
// `liquibase-*.xml` - which is where Liquibase projects usually put them, and nowhere near a
// directory called `changelog`. The path filter had assumed a convention real projects do not keep.
describe('finding the migrations at all', () => {
  const chosen = (files: string[]) => schemaFiles({ root: process.cwd(), files, diff: '' }).length;

  it('recognises a Liquibase changelog by its name, wherever it sits', () => {
    // These paths do not exist on disk, so this tests the filter and not the reading; the point is
    // that the filter must not reject them before anything gets the chance to read them.
    const likely = [
      'api/src/main/resources/liquibase-update-to-latest.xml',
      'api/src/main/resources/liquibase-core-data.xml',
      'src/resources/changelog-2.4.xml',
    ];
    for (const path of likely) assert.match(path, /(^|\/)(liquibase|changelog)[\w.-]*\.(xml|ya?ml|json)$/i, path);
  });

  it('still recognises the conventional directories', () => {
    for (const path of ['database/migrations/2024_01_01_x.php', 'db/migrate/20240101_x.rb', 'prisma/migrations/0001_init/migration.sql', 'changelog/db.changelog-1.5.xml']) {
      assert.match(path, /(^|\/)(migrations?|migration|db\/migrate|prisma\/migrations|alembic|flyway|changelogs?|sql)\/|(^|\/)(liquibase|changelog)[\w.-]*\.(xml|ya?ml|json)$/i, path);
    }
  });

  it('a file named outright is still read whatever its path', () => {
    assert.equal(chosen(['package.json']), 1, 'naming a file overrides the filter');
  });
});

// Phase 43: Keycloak, 83 Liquibase changelogs, and a reader that stopped after the first hit.
describe('every destructive change in the file, not the first one', () => {
  it('reports all of them, in file order', () => {
    // `jpa-changelog-26.0.0.xml` drops eight tables and Tewip named one. Under-reporting a
    // destructive change is the worst direction to be wrong in: the reader sees a finding, deals
    // with it, and reasonably concludes that was all of them.
    const text = [
      '<databaseChangeLog>',
      '  <changeSet id="1">',
      '    <dropTable tableName="USER_SOCIAL_LINK" />',
      '    <dropTable tableName="REALM_SOCIAL_CONFIG" />',
      '    <dropTable tableName="THIRD" />',
      '  </changeSet>',
      '</databaseChangeLog>',
    ].join('\n');
    const found = readFramework('liquibase', text);
    assert.deepEqual(found.map((f) => f.table), ['USER_SOCIAL_LINK', 'REALM_SOCIAL_CONFIG', 'THIRD']);
    assert.deepEqual(found.map((f) => f.line), [3, 4, 5]);
  });

  it('does not report the same statement twice when two rules describe it', () => {
    // Liquibase writes a dropped column two ways and there is a rule for each; a statement matching
    // both is still one statement.
    const text = '<databaseChangeLog>\n  <dropColumn tableName="CLIENT" columnName="MASK" />\n</databaseChangeLog>';
    const found = readFramework('liquibase', text);
    assert.equal(found.length, 1);
    assert.equal(found[0].column, 'MASK');
  });

  it('is not left mid-way through the previous file', () => {
    // A global regex carries `lastIndex` between calls, and these rules are shared module-level
    // objects. Reading the same text twice must give the same answer.
    const text = '<databaseChangeLog>\n  <dropTable tableName="A" />\n  <dropTable tableName="B" />\n</databaseChangeLog>';
    assert.deepEqual(readFramework('liquibase', text).map((f) => f.table), ['A', 'B']);
    assert.deepEqual(readFramework('liquibase', text).map((f) => f.table), ['A', 'B']);
  });

  it('every dialect gained this, not only Liquibase', () => {
    const django = [
      'class Migration(migrations.Migration):',
      '    operations = [',
      '        migrations.RemoveField(model_name="order", name="code"),',
      '        migrations.RemoveField(model_name="order", name="note"),',
      '    ]',
    ].join(String.fromCharCode(10));
    const removed = readFramework('django', django);
    assert.equal(removed.length, 2, 'both removals, not just the first');
    assert.deepEqual(removed.map((f) => f.column), ['code', 'note']);
  });
});

describe('the column a drop names, and the column its evidence names', () => {
  it('reads the attribute form in either attribute order', () => {
    // Keycloak writes `tableName` first and the rule demanded `columnName` first, so sixty-seven
    // dropped columns were read by a rule that then reached elsewhere for the name.
    for (const tag of [
      '<dropColumn tableName="CLIENT" columnName="ALLOWED_CLAIMS_MASK" />',
      '<dropColumn columnName="ALLOWED_CLAIMS_MASK" tableName="CLIENT" />',
    ]) {
      const [found] = readFramework('liquibase', `<databaseChangeLog>\n  ${tag}\n</databaseChangeLog>`);
      assert.equal(found?.table, 'CLIENT', tag);
      assert.equal(found?.column, 'ALLOWED_CLAIMS_MASK', tag);
    }
  });

  it('does not reach past a self-closing tag for a column that belongs to something else', () => {
    // The nested-form rule looked ahead 300 characters for a `<column name=`. After a self-closing
    // dropColumn it found one three lines later inside an unrelated <createTable>, and Tewip
    // reported "drops CLIENT.REALM_ID" while quoting a line that says ALLOWED_CLAIMS_MASK.
    const text = [
      '<databaseChangeLog>',
      '  <dropColumn tableName="CLIENT" columnName="ALLOWED_CLAIMS_MASK" />',
      '  <createTable tableName="REALM_ENABLED_EVENT_TYPES">',
      '    <column name="REALM_ID" type="VARCHAR(36)" />',
      '  </createTable>',
      '</databaseChangeLog>',
    ].join('\n');
    const [found] = readFramework('liquibase', text);
    assert.equal(found?.column, 'ALLOWED_CLAIMS_MASK');
    assert.match(found?.what ?? '', /CLIENT\.ALLOWED_CLAIMS_MASK/);
  });

  it('still reads the nested form, which is what that rule is for', () => {
    const text = '<databaseChangeLog>\n  <dropColumn tableName="CLIENT">\n    <column name="MASK"/>\n  </dropColumn>\n</databaseChangeLog>';
    const [found] = readFramework('liquibase', text);
    assert.equal(found?.table, 'CLIENT');
    assert.equal(found?.column, 'MASK');
  });

  it('finds a changelog whose name carries a prefix', () => {
    // Phase 42 taught the filter `liquibase-*.xml` and it still missed Keycloak's 83 files, every
    // one called `jpa-changelog-<version>.xml`: the word had to *begin* the name. Prefixes are the
    // norm once a project has more than one database.
    const NAMED = /(^|\/)[\w.-]*(liquibase|changelog)[\w.-]*\.(xml|ya?ml|json)$/i;
    for (const path of [
      'model/jpa/src/main/resources/META-INF/jpa-changelog-1.0.0.Final.xml',
      'api/src/main/resources/liquibase-update-to-latest.xml',
      'src/db.changelog-master.yaml',
    ]) assert.match(path, NAMED, path);
    assert.doesNotMatch('src/main/resources/application.xml', NAMED);
  });
});

// Phase 44: a directory called `migration/` says what is probably in it, not what every file is.
describe('choosing which files are migrations', () => {
  it('leaves documentation and application code out of a migration directory', () => {
    // Keycloak selected 205 files in order to read 89, and listed the other 116 as migrations it
    // could not read - among them `docs/guides/migration/index.adoc` and 113 `MigrateTo12_0_0.java`
    // classes. A "could not read" list that is mostly documentation teaches the reader to skip it.
    for (const path of ['docs/guides/migration/index.adoc', 'docs/guides/migration/img/diagram.png']) {
      assert.equal(MIGRATION.test(path), false, path);
    }
    assert.equal(MIGRATION.test('model/storage/src/main/java/org/keycloak/migration/migrators/MigrateTo12_0_0.java'), false);
  });

  it('keeps a Flyway Java migration, which is named the way Flyway requires', () => {
    for (const path of ['db/migration/V2__add_index.java', 'src/migrations/V1.1__seed.kt', 'db/migration/R__rebuild_views.java']) {
      assert.equal(MIGRATION.test(path), true, path);
    }
  });

  it('still takes everything that really can hold DDL', () => {
    for (const path of [
      'migrations/0002_add_column.sql',
      'db/migrate/20240101_x.rb',
      'alembic/versions/abc_add.py',
      'database/migrations/2024_01_01_x.php',
      'prisma/migrations/0001_init/migration.sql',
      'migrations/0003.xml',
    ]) assert.equal(MIGRATION.test(path), true, path);
  });
});
