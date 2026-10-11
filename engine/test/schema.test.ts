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
