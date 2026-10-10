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
import { dialectOf, irreversible, readFramework } from '../schema/frameworks.ts';
import { readSql, statementsOf } from '../schema/statements.ts';

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
