// `tewip schema --diff main...HEAD`: what this migration will do to a live database.
//
// The part that no SQL linter does, and the reason this belongs in Tewip rather than in a linter: it
// looks for the code that still uses what the migration takes away. "This drops users.nickname, and four
// files still read it" is a different sentence from "dropping a column is risky", and it is the one that
// stops the outage.
//
// That check is a search of the repository, so it is evidence rather than proof, and it is worded as
// such. A mention in a comment counts as a mention; Tewip says where it looked and lets the reader judge.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { changeSummary } from '../quality/grounding.ts';
import { dialectOf, forwardOnly, irreversible, readFramework, type Dialect } from './frameworks.ts';
import { readSql, type Finding, type Risk } from './statements.ts';

export interface SchemaCommand {
  root: string;
  diff: string;
  /** Files to read, instead of a git range. */
  files?: string[];
  out?: string;
  /** Exit non-zero when something would break the running code or destroy data. */
  strict?: boolean;
}

export interface Migration {
  file: string;
  dialect: Dialect;
  findings: Finding[];
  /** Why nothing was read, when nothing was. */
  unread: string;
  /** Cannot be undone by running its own down step. */
  irreversible: boolean;
}

export interface StillUsed {
  table: string;
  column: string;
  /** Files outside migrations that still name it. */
  files: string[];
}

const MIGRATION = /(^|\/)(migrations?|db\/migrate|prisma\/migrations|alembic|flyway|sql)\//i;
const SCHEMA_FILE = /\.(sql)$|(^|\/)(migrations?|db\/migrate)\/.*\.(py|rb|js|ts)$/i;

/** The schema files in this change. */
export function schemaFiles(cmd: SchemaCommand): string[] {
  const named = cmd.files !== undefined && cmd.files.length > 0;
  const given = named ? cmd.files! : (changeSummary(cmd.root, cmd.diff)?.files ?? []);
  return given
    .map((f) => f.split('\\').join('/'))
    // Asking for a file by name overrides the path filter: the filter exists to find migrations in
    // a diff of a hundred files, not to argue with somebody who pointed at one. A TypeORM migration
    // sitting outside a migrations/ directory was being answered with "no migration in this change".
    .filter((f) => (named || SCHEMA_FILE.test(f) || MIGRATION.test(f)) && existsSync(resolve(cmd.root, f)));
}

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
  for (const m of text.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w$.]+)"?/gi)) {
    names.add(m[1].toLowerCase().replace(/^.*\./, ''));
  }
  return names;
}

/** Risks that are only risks because rows already exist. */
const ONLY_HURTS_EXISTING_ROWS = new Set<Risk>(['locks-writes', 'slow']);

export function droppingWhatIsNew(findings: Finding[], text: string): Finding[] {
  const fresh = createdHere(text);
  if (fresh.size === 0) return findings;
  return findings.filter((f) => !(ONLY_HURTS_EXISTING_ROWS.has(f.risk) && fresh.has(f.table.toLowerCase().replace(/^.*\./, ''))));
}

export function readMigration(root: string, file: string): Migration {
  let text = '';
  try {
    text = readFileSync(resolve(root, file), 'utf8');
  } catch {
    return { file, dialect: 'unknown', findings: [], unread: 'the file could not be read', irreversible: false };
  }
  const dialect = dialectOf(file, text);
  // Only the forward path: a rollback step contains the mirror image of the change, and reading it as
  // part of the change says a migration that creates a table destroys one.
  const forward = forwardOnly(dialect, text);
  if (dialect === 'sql') return { file, dialect, findings: droppingWhatIsNew(readSql(forward), forward), unread: '', irreversible: false };
  if (dialect === 'unknown') {
    return {
      file,
      dialect,
      findings: [],
      unread: 'Tewip does not recognise how this migration is written, so it says nothing about it rather than passing it. It reads SQL, Django, Rails, Alembic, TypeORM, Sequelize, Knex, EF Core and Liquibase migrations',
      irreversible: false,
    };
  }
  const findings = readFramework(dialect, forward);
  // A migration that only runs raw SQL through the framework is still readable: the SQL is the migration.
  // Raw SQL, however it reaches the database: through the framework, or through a cursor inside a data
  // migration, which is where most large projects put the dangerous parts.
  // `queryRunner.query` is TypeORM's, and is the whole of a TypeORM migration rather than an
  // escape hatch inside one: the class is a wrapper and every statement arrives this way.
  const raw = [...forward.matchAll(/(?:RunSQL|op\.execute|queryRunner\.query|execute|cursor\.execute)\(\s*(?:r?["'`]{1,3})([\s\S]*?)["'`]{1,3}\s*[,)]/g)].map((m) => m[1]).join(';');
  if (raw.trim()) findings.push(...readSql(raw));
  return { file, dialect, findings: droppingWhatIsNew(findings, forward), unread: '', irreversible: irreversible(dialect, text) };
}

/**
 * Code outside the migrations that still names a table or column this change takes away.
 *
 * `git grep` because it respects the repository's own ignore rules and is fast on a large tree. A column
 * named `name` or `id` is not searched for: everything matches it, and a finding that always fires teaches
 * a reader to ignore the whole report.
 */
export function stillUsed(root: string, findings: Finding[]): StillUsed[] {
  const out: StillUsed[] = [];
  const tooCommon = new Set(['id', 'name', 'type', 'value', 'data', 'key', 'status', 'state', 'date', 'time', 'user', 'count', 'index', 'order', 'group', 'text', 'url', 'size', 'code']);
  for (const finding of findings) {
    if (finding.risk !== 'breaks-old-code' && finding.risk !== 'destroys-data') continue;
    const what = finding.column || finding.table;
    if (!what || what.length < 4 || tooCommon.has(what.toLowerCase())) continue;
    if (out.some((u) => u.table === finding.table && u.column === finding.column)) continue;
    let files = grepFor(root, what);
    // A bare column name is too weak on its own. Dropping `fasp_providers.capabilities` from Mastodon
    // matched 37 files including a Dockerfile and an emoji module, because "capabilities" is an ordinary
    // word - and noise in the one section meant to be the differentiator is worse than silence. So when a
    // column is named, the file has to mention the table as well.
    if (finding.column && finding.table) {
      const named = new Set([...grepFor(root, finding.table), ...grepFor(root, singular(finding.table))]);
      files = files.filter((f) => named.has(f));
    }
    if (files.length > 0) out.push({ table: finding.table, column: finding.column, files });
  }
  return out;
}

/** Files naming this word, excluding migrations and documentation. */
function grepFor(root: string, word: string): string[] {
  if (!word || word.length < 4) return [];
  const found = spawnSync('git', ['grep', '-l', '-w', '--', word], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return (found.stdout ?? '')
    .split(String.fromCharCode(10))
    .map((l) => l.trim().split(String.fromCharCode(92)).join('/'))
    .filter((l) => l && !MIGRATION.test(l) && !/\.(md|txt|lock|json)$/i.test(l));
}

/** `fasp_providers` is the table; the code calls the model `FaspProvider`, so the singular is searched too. */
const singular = (table: string): string => (table.endsWith('ies') ? table.slice(0, -3) + 'y' : table.endsWith('s') && !table.endsWith('ss') ? table.slice(0, -1) : table);

const ORDER: Finding['risk'][] = ['breaks-old-code', 'destroys-data', 'locks-writes', 'slow', 'irreversible', 'fine'];
const TITLES: Record<Finding['risk'], string> = {
  'breaks-old-code': 'Breaks the version that is still running',
  'destroys-data': 'Destroys data',
  'locks-writes': 'Blocks writes while it runs',
  slow: 'Holds a long transaction',
  irreversible: 'Cannot be undone',
  fine: 'Worth knowing',
};

export function renderSchema(migrations: Migration[], used: StillUsed[]): string {
  const all = migrations.flatMap((m) => m.findings);
  const serious = all.filter((f) => f.risk === 'breaks-old-code' || f.risk === 'destroys-data');
  const lines = [
    '# What this migration does to a live database',
    '',
    migrations.length === 0
      ? 'No migration or schema file in this change.'
      : `${migrations.filter((m) => !m.unread).length} of ${migrations.length} migration file(s) read. **${serious.length}** change(s) would break the running version or destroy data; ${all.length - serious.length} other finding(s).`,
    '',
    // "Read, and nothing found" must never look like "not read". A reader who cannot tell them apart will
    // take silence for safety, which is the one thing this report must not allow.
    ...(migrations.length > 0 && all.length === 0 && migrations.every((m) => !m.unread)
      ? [`All ${migrations.length} were read, and nothing in them breaks the running version, destroys data, blocks writes or holds a long transaction.`]
      : []),
    '',
  ];

  for (const risk of ORDER) {
    const group = all.filter((f) => f.risk === risk);
    if (group.length === 0) continue;
    lines.push(`## ${TITLES[risk]} (${group.length})`, '');
    for (const finding of group) {
      const where = migrations.find((m) => m.findings.includes(finding));
      lines.push(`- **${finding.what}** — \`${where?.file ?? ''}:${finding.line}\``);
      lines.push(`  - \`${finding.statement.replace(/`/g, "'")}\``);
      lines.push(`  - Instead: ${finding.instead}`);
    }
    lines.push('');
  }

  if (used.length > 0) {
    lines.push(
      `## Code that still uses what this takes away (${used.length})`,
      '',
      'Found by searching the repository, so it is evidence rather than proof - a match may be a comment or',
      'an unrelated name. Each one is worth opening before this ships.',
      '',
    );
    for (const u of used) {
      lines.push(`- **${u.column ? `${u.table}.${u.column}` : u.table}** is still named in ${u.files.length} file(s): ${u.files.slice(0, 6).join(', ')}${u.files.length > 6 ? `, and ${u.files.length - 6} more` : ''}`);
    }
    lines.push('');
  }

  const irreversibles = migrations.filter((m) => m.irreversible);
  if (irreversibles.length > 0) {
    lines.push(`## Cannot be rolled back by its own down step (${irreversibles.length})`, '', ...irreversibles.map((m) => `- \`${m.file}\``), '');
  }

  const unread = migrations.filter((m) => m.unread);
  if (unread.length > 0) {
    lines.push(`## Not read (${unread.length})`, '', ...unread.map((m) => `- \`${m.file}\`: ${m.unread}`), '');
  }

  lines.push(
    '---',
    '',
    'Every line above is read from the migration itself; no model was called and nothing was guessed.',
    '',
    'What this does not know: how large your tables are, how busy the database is, and therefore how long',
    'any of this takes. It says what a statement does - rewrites the table, scans every row, blocks writes -',
    'and leaves the duration to the person who knows the data. It also cannot see a deployment order, so',
    '"breaks the running version" means during a rolling deploy, which is the usual case.',
  );
  return lines.join(String.fromCharCode(10));
}

export function runSchema(cmd: SchemaCommand): { serious: number } {
  const files = schemaFiles(cmd);
  const migrations = files.map((file) => readMigration(cmd.root, file));
  const used = stillUsed(cmd.root, migrations.flatMap((m) => m.findings));
  const report = renderSchema(migrations, used);
  console.log(report);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), report + String.fromCharCode(10), 'utf8');
  }
  const serious = migrations.flatMap((m) => m.findings).filter((f) => f.risk === 'breaks-old-code' || f.risk === 'destroys-data').length;
  if (cmd.strict && serious > 0) {
    console.error(String.fromCharCode(10) + `${serious} change(s) here would break the running version or destroy data.`);
    process.exitCode = 1;
  }
  return { serious };
}
