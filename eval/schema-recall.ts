// How much `tewip schema` finds, measured against what the databases document about themselves.
//
// The corpus pins what `schema` reports on real projects, which holds it steady but cannot say
// what it walks past: a migration nobody wrote is a migration nobody measures. This plants one per
// case and asks.
//
// The ground truth is the databases' own documentation - PostgreSQL and MySQL publish which
// statements take which lock, and which of them rewrite a table or throw data away. Every case
// below is one of those, written as a migration in the dialect a team would actually commit, and
// labelled with what the manual says rather than with what Tewip's rules say. Where the two agree
// that is the check being right; where they disagree the miss is real and is named.
//
// What this cannot measure is the opposite direction - a migration that looks dangerous and is
// safe in context, because context is exactly what a file does not carry. The corpus covers that
// side by holding the false positive count at zero across 14 real projects.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigration } from '../engine/schema/schema-command.ts';

const NL = String.fromCharCode(10);

/** What the database's own manual says this statement does. */
type Harm = 'destroys-data' | 'breaks-old-code' | 'locks-writes' | 'slow';

interface Case {
  name: string;
  /** The dialect the file is written in, which decides the extension and the shape. */
  dialect: 'sql' | 'django' | 'rails' | 'alembic';
  /** What the documentation says, in its own terms. */
  documented: string;
  /**
   * Every harm the manual describes, not one.
   *
   * `DROP COLUMN` throws the data away *and* breaks the code still selecting it, and a statement
   * usually does more than one thing. Written as a single expected harm, four correct findings
   * scored as misses because Tewip named the other true one - the measurement being too narrow,
   * not the check being wrong.
   */
  expect: Harm[];
  body: string;
}

const CASES: Case[] = [
  {
    name: 'drop-table',
    dialect: 'sql',
    documented: 'PostgreSQL: DROP TABLE removes the table and all data in it',
    expect: ['destroys-data'],
    body: 'DROP TABLE orders;',
  },
  {
    name: 'drop-column',
    dialect: 'sql',
    documented: 'PostgreSQL: DROP COLUMN discards the data in that column',
    expect: ['destroys-data', 'breaks-old-code'],
    body: 'ALTER TABLE customers DROP COLUMN last_login;',
  },
  {
    name: 'truncate',
    dialect: 'sql',
    documented: 'PostgreSQL: TRUNCATE empties a table, and takes an ACCESS EXCLUSIVE lock',
    expect: ['destroys-data'],
    body: 'TRUNCATE TABLE audit_log;',
  },
  {
    name: 'narrowing-type',
    dialect: 'sql',
    documented: 'PostgreSQL: ALTER COLUMN TYPE to a narrower type rewrites the table and may fail on existing rows',
    expect: ['destroys-data', 'locks-writes'],
    body: 'ALTER TABLE invoices ALTER COLUMN reference TYPE varchar(10);',
  },
  {
    name: 'rename-column',
    dialect: 'sql',
    documented: 'PostgreSQL: RENAME COLUMN takes effect at once, and the old name stops resolving',
    expect: ['breaks-old-code'],
    body: 'ALTER TABLE users RENAME COLUMN email TO email_address;',
  },
  {
    name: 'not-null-without-default',
    dialect: 'sql',
    documented: 'PostgreSQL: SET NOT NULL scans the whole table and fails if any row holds a null',
    expect: ['breaks-old-code'],
    body: 'ALTER TABLE users ADD COLUMN country text NOT NULL;',
  },
  {
    name: 'index-without-concurrently',
    dialect: 'sql',
    documented: 'PostgreSQL: CREATE INDEX blocks writes to the table for the duration; CONCURRENTLY does not',
    expect: ['locks-writes'],
    body: 'CREATE INDEX idx_orders_customer ON orders (customer_id);',
  },
  {
    name: 'check-constraint-validated',
    dialect: 'sql',
    documented: 'PostgreSQL: ADD CONSTRAINT scans and locks unless it is added NOT VALID',
    expect: ['locks-writes'],
    body: 'ALTER TABLE orders ADD CONSTRAINT total_positive CHECK (total > 0);',
  },
  {
    name: 'update-without-where',
    dialect: 'sql',
    documented: 'PostgreSQL: an UPDATE with no WHERE rewrites every row and holds its locks until commit',
    expect: ['slow'],
    body: "UPDATE orders SET status = 'migrated';",
  },
  {
    name: 'django-remove-field',
    dialect: 'django',
    documented: 'Django: RemoveField drops the column, and the data with it',
    expect: ['destroys-data', 'breaks-old-code'],
    body: ['from django.db import migrations', '', 'class Migration(migrations.Migration):', '    operations = [', "        migrations.RemoveField(model_name='customer', name='last_login'),", '    ]'].join(NL),
  },
  {
    name: 'django-delete-model',
    dialect: 'django',
    documented: 'Django: DeleteModel drops the table',
    expect: ['destroys-data'],
    body: ['from django.db import migrations', '', 'class Migration(migrations.Migration):', '    operations = [', "        migrations.DeleteModel(name='Order'),", '    ]'].join(NL),
  },
  {
    name: 'rails-remove-column',
    dialect: 'rails',
    documented: 'Rails: remove_column drops the column and its data',
    expect: ['destroys-data', 'breaks-old-code'],
    body: ['class RemoveLastLogin < ActiveRecord::Migration[7.1]', '  def change', '    remove_column :customers, :last_login, :datetime', '  end', 'end'].join(NL),
  },
  {
    name: 'rails-add-index',
    dialect: 'rails',
    documented: 'Rails: add_index without algorithm: :concurrently blocks writes',
    expect: ['locks-writes'],
    body: ['class AddIndex < ActiveRecord::Migration[7.1]', '  def change', '    add_index :orders, :customer_id', '  end', 'end'].join(NL),
  },
  {
    name: 'alembic-drop-column',
    dialect: 'alembic',
    documented: 'Alembic: op.drop_column removes the column and its data',
    expect: ['destroys-data', 'breaks-old-code'],
    body: ['from alembic import op', '', 'def upgrade():', "    op.drop_column('customers', 'last_login')"].join(NL),
  },
  {
    name: 'alembic-drop-table',
    dialect: 'alembic',
    documented: 'Alembic: op.drop_table removes the table',
    expect: ['destroys-data'],
    body: ['from alembic import op', '', 'def upgrade():', "    op.drop_table('audit_log')"].join(NL),
  },
];

/** Migrations the manual says are safe, planted so the run reports what it wrongly accuses. */
const SAFE: Case[] = [
  { name: 'add-nullable-column', dialect: 'sql', documented: 'PostgreSQL: ADD COLUMN with no default and no NOT NULL is metadata only', expect: ['slow'], body: 'ALTER TABLE users ADD COLUMN nickname text;' },
  { name: 'create-table', dialect: 'sql', documented: 'a new table touches nothing that exists', expect: ['slow'], body: 'CREATE TABLE sessions (id bigserial primary key, created_at timestamptz);' },
  { name: 'index-concurrently', dialect: 'sql', documented: 'PostgreSQL: CREATE INDEX CONCURRENTLY does not block writes', expect: ['locks-writes'], body: 'CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id);' },
  { name: 'constraint-not-valid', dialect: 'sql', documented: 'PostgreSQL: ADD CONSTRAINT ... NOT VALID does not scan the table', expect: ['locks-writes'], body: 'ALTER TABLE orders ADD CONSTRAINT total_positive CHECK (total > 0) NOT VALID;' },
];

const EXTENSION: Record<Case['dialect'], string> = { sql: 'sql', django: 'py', rails: 'rb', alembic: 'py' };
const FOLDER: Record<Case['dialect'], string> = { sql: 'migrations', django: 'app/migrations', rails: 'db/migrate', alembic: 'alembic/versions' };

export interface Measured {
  name: string;
  documented: string;
  expect: Harm[];
  /** What Tewip said about it, if anything. */
  found: string[];
  /** Did it name the harm the manual names. */
  right: boolean;
}

export function measure(): { dangerous: Measured[]; safe: Measured[] } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-schema-recall-'));
  try {
    const judge = (c: Case): Measured => {
      const file = `${FOLDER[c.dialect]}/0001_${c.name}.${EXTENSION[c.dialect]}`;
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), c.body, 'utf8');
      const migration = readMigration(root, file);
      const found = [...new Set(migration.findings.map((f) => f.risk))];
      return { name: c.name, documented: c.documented, expect: c.expect, found, right: c.expect.some((h) => found.includes(h)) };
    };
    return { dangerous: CASES.map(judge), safe: SAFE.map(judge) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function report(): void {
  const { dangerous, safe } = measure();
  const right = dangerous.filter((d) => d.right);
  const silent = dangerous.filter((d) => d.found.length === 0);
  const accused = safe.filter((s) => s.expect.some((h) => s.found.includes(h)));
  const pct = (n: number) => `${((n / dangerous.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      '# schema, measured against what the databases document',
      '',
      `${dangerous.length} migrations, each one a statement PostgreSQL, MySQL or the framework's own manual`,
      'describes as destructive, breaking or blocking - labelled with what the documentation says, not',
      "with what Tewip's rules say.",
      '',
      `Named the harm the manual names:  ${right.length} of ${dangerous.length} (${pct(right.length)})`,
      `Said nothing at all:              ${silent.length}`,
      '',
      '## The ones it did not name',
      '',
      ...(dangerous.filter((d) => !d.right).length === 0
        ? ['None.']
        : dangerous
            .filter((d) => !d.right)
            .map((d) => `- **${d.name}** — expected ${d.expect.map((h) => `\`${h}\``).join(' or ')}, got ${d.found.length === 0 ? 'nothing' : d.found.map((f) => `\`${f}\``).join(', ')}${NL}  - ${d.documented}`)),
      '',
      '## What it wrongly accused',
      '',
      `${safe.length} migrations the manual calls safe, planted beside them: a nullable column, a new table, an`,
      'index built concurrently, a constraint added NOT VALID. The last two matter most - they are the',
      'documented way to do the dangerous thing safely, and a check that cannot tell them apart teaches',
      'people to ignore it.',
      '',
      ...(accused.length === 0 ? ['None of them was given the harm it avoids.'] : accused.map((a) => `- **${a.name}** — called ${a.expect.map((h) => `\`${h}\``).join(' or ')}. ${a.documented}`)),
      '',
    ].join(NL),
  );
}

if (process.argv[1]?.includes('schema-recall')) report();
