// `tewip` with nothing after it: look at this project and say what Tewip can actually do for it.
//
// Until now the answer to "I installed it, now what" was 233 lines of help listing eleven commands,
// which is a reference for somebody who already knows what they want and a wall for everybody else.
// Eleven commands is already more than most teams will run; the problem was never the number of
// things Tewip can do, it was that none of them were connected to *this* repository.
//
// So this looks. It counts what is actually here - test files and which framework wrote them,
// migrations and which tool, markup and which template language, a k6 or JMeter or Lighthouse
// report somebody has already produced - and then names the two or three commands that will tell
// this team something, with their own paths in them. And it says what Tewip cannot do here, because
// a front door that implies it can do everything is the same lie as a report with no limits on it.
//
// Nothing is run and nothing is written. It reads the directory and stops.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { languageOf, looksLikeTests } from '../vouch/tests-in.ts';
import { MARKUP } from '../access/markup.ts';
import { dialectOf } from '../schema/frameworks.ts';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.cache', '.tewip', '.triage-agent']);

export interface Found {
  /** Test files, by the language they are written in. */
  tests: Map<string, number>;
  /** Migrations, by the tool that wrote them. */
  migrations: Map<string, number>;
  markup: number;
  /** Performance reports already sitting in the repository. */
  perfReports: string[];
  hasWorkflows: boolean;
  hasStandards: boolean;
  filesSeen: boolean;
  /**
   * True when the walk stopped before it ran out of project. Saleor has 4698 files against a budget
   * of 4000, so every count it produced was a sample reported as a total - "1218 test files here"
   * when there are 1229. Small, and exactly the kind of over-claim this tool exists to refuse,
   * on precisely the large repositories where nobody can check it by hand.
   */
  stoppedEarly: boolean;
}

/**
 * A bounded look: enough to recognise a project, not enough to be slow on a large one.
 *
 * Breadth-first, and that is the whole correctness of it. Depth-first with a budget spends the
 * budget wherever the alphabet happens to lead: pointed at Tewip itself it descended into `data/`,
 * exhausted 4000 files on stored datasets, and reported **7 test files in a repository with 69**.
 * A number that wrong is worse than no number, because the front door is the one place a person
 * has no way to tell. Breadth-first sees every top-level directory before descending into any of
 * them, so the budget is spent on breadth, which is what recognising a project needs.
 */
export function lookAround(root: string, limit = 4000): Found {
  const found: Found = {
    tests: new Map(),
    migrations: new Map(),
    markup: 0,
    perfReports: [],
    hasWorkflows: existsSync(join(root, '.github', 'workflows')),
    hasStandards: existsSync(join(root, '.tewip', 'standards')),
    filesSeen: false,
    stoppedEarly: false,
  };
  let seen = 0;

  // A queue rather than recursion: every directory at one depth is read before any at the next.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && seen < limit) {
    const { dir, depth } = queue.shift()!;
    if (depth > 8) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Out of budget with entries still unread in *this* directory. Checking only the queue was
      // not enough: a project whose files sit in one flat directory empties the queue before the
      // budget runs out, so the look stopped short and did not know it.
      if (seen >= limit) {
        found.stoppedEarly = true;
        break;
      }
      if (SKIP.has(entry) || (entry.startsWith('.') && entry !== '.github')) continue;
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      seen += 1;
      found.filesSeen = true;
      const rel = relative(root, full).replaceAll('\\', '/');

      if (MARKUP.test(entry)) found.markup += 1;

      if (/\.jtl$/i.test(entry)) found.perfReports.push(rel);
      else if (/(k6|lighthouse|summary|lhr)[\w.-]*\.json$/i.test(entry) && info.size < 8_000_000) found.perfReports.push(rel);

      // A changelog is often not in a directory that says so: OpenMRS keeps 44 Liquibase files in
      // `api/src/main/resources/` named `liquibase-*.xml`. The name counts as well as the path - and
      // the word may sit anywhere in it, because Keycloak's 83 are `jpa-changelog-<version>.xml`.
      const inMigrations =
        /(^|\/)(migrations?|migration|db\/migrate|changelogs?)\//i.test(rel) ||
        /(^|\/)[\w.-]*(liquibase|changelog)[\w.-]*\.(xml|ya?ml|json)$/i.test(rel);
      // Reading a file is only worth it for the two questions a name cannot answer: is this a
      // test, and is this a migration. Both are cheap, and both are often wrong from the path.
      const language = languageOf(entry);
      const worthReading = (language !== null || /\.(sql|xml)$/i.test(entry)) && info.size < 1_000_000;
      if (!worthReading) continue;
      let text = '';
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (language && looksLikeTests(rel, text)) found.tests.set(language, (found.tests.get(language) ?? 0) + 1);
      if (inMigrations) {
        const dialect = dialectOf(rel, text);
        if (dialect !== 'unknown') found.migrations.set(dialect, (found.migrations.get(dialect) ?? 0) + 1);
      }
    }
  }

  if (seen >= limit && queue.length > 0) found.stoppedEarly = true;
  return found;
}

interface Suggestion {
  command: string;
  because: string;
}

const total = (counts: Map<string, number>): number => [...counts.values()].reduce((a, b) => a + b, 0);

/** What a person calls these, rather than what the code calls them. */
const PLAIN: Record<string, string> = {
  js: 'JavaScript or TypeScript',
  python: 'Python',
  jvm: 'Java, Kotlin or Scala',
  go: 'Go',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  rust: 'Rust',
  sql: 'SQL',
  django: 'Django',
  rails: 'Rails',
  alembic: 'Alembic',
  typeorm: 'TypeORM',
  sequelize: 'Sequelize',
  knex: 'Knex',
  efcore: 'EF Core',
  liquibase: 'Liquibase',
};

const named = (counts: Map<string, number>): string =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    // Only the ones worth naming: a repository with one stray file in a ninth language does not
    // need all nine listed at the front door.
    .slice(0, 3)
    .map(([name, n]) => `${n} ${PLAIN[name] ?? name}`)
    .join(', ');

/** The two or three things worth running here, most useful first. */
export function suggest(found: Found): Suggestion[] {
  const out: Suggestion[] = [];
  const tests = total(found.tests);
  const migrations = total(found.migrations);

  if (tests > 0) {
    out.push({
      command: 'tewip vouch',
      because: `${found.stoppedEarly ? 'At least ' : ''}${tests} test ${tests === 1 ? 'file' : 'files'} here (${named(found.tests)}). This reads them and names the ones that cannot fail - no model, a second or two.`,
    });
  }
  if (migrations > 0) {
    out.push({
      command: 'tewip schema --diff main...HEAD',
      because: `${found.stoppedEarly ? 'At least ' : ''}${migrations} ${migrations === 1 ? 'migration' : 'migrations'} here (${named(found.migrations)}). This says what a change would do to a live database before it runs.`,
    });
  }
  if (found.markup > 0) {
    out.push({
      command: 'tewip access',
      because: `${found.stoppedEarly ? 'At least ' : ''}${found.markup} markup ${found.markup === 1 ? 'file' : 'files'} here. This names who cannot use the interface, against the WCAG criterion a regulator would cite.`,
    });
  }
  for (const report of found.perfReports.slice(0, 1)) {
    out.push({
      command: `tewip perf ${report}`,
      because: 'there is already a performance report here, and Tewip will judge it rather than restate it.',
    });
  }
  if (tests > 0) {
    out.push({
      command: 'tewip done',
      because: 'the one verdict over your current change, once you have made one. It answers ready, not ready, or cannot say.',
    });
  }
  return out;
}

export function renderStart(found: Found, root: string): string {
  const lines = ['# Tewip', ''];

  if (!found.filesSeen) {
    lines.push(`There is nothing to read in \`${root}\`. Run Tewip from the root of a project.`, '');
    return lines.join('\n');
  }

  const suggestions = suggest(found);
  if (suggestions.length === 0) {
    lines.push(
      `Tewip looked around \`${root}\` and found nothing it can judge: no test files, no migrations, no markup, ` +
        'and no performance report. That is an honest answer rather than a failure - point it at a project with ' +
        'tests in it, or run `tewip --help` for the full list.',
      '',
    );
    return lines.join('\n');
  }

  lines.push('Here is what Tewip can tell you about **this** project, in the order worth doing.', '');
  for (const [i, s] of suggestions.entries()) {
    lines.push(`**${i + 1}. \`${s.command}\`**`, '', s.because, '');
  }

  lines.push('## What it will not do here', '');
  const cannot: string[] = [];
  if (found.stoppedEarly) {
    cannot.push(
      'This project is larger than Tewip looks at from here, so the counts above are **at least** ' +
        'that many rather than exactly. The commands themselves read everything; only this first ' +
        'glance is bounded, so that it stays instant.',
    );
  }
  if (total(found.tests) === 0) cannot.push('No test files were found, so nothing can be said about whether your tests could fail or would catch a bug.');
  if (total(found.migrations) === 0) cannot.push('No migrations were found, so nothing is said about your database.');
  if (found.markup === 0) cannot.push('No markup was found, so nothing is said about accessibility.');
  if (found.perfReports.length === 0) cannot.push('No k6, JMeter or Lighthouse report was found. Tewip judges one you produce; it does not run load tests itself.');
  if (!found.hasStandards) cannot.push('This project has not taught Tewip any house rules yet. Put a markdown file in `.tewip/standards/` and `tewip standards` will enforce it.');
  if (!found.hasWorkflows) cannot.push('There is no GitHub Actions workflow here. `uses: hmamut39/tewip@main` with `mode: check` runs these same checks on every pull request.');
  else cannot.push('You have GitHub Actions. `mode: check` runs these same checks on every pull request.');
  for (const line of cannot) lines.push(`- ${line}`);
  lines.push('');

  lines.push(
    'Everything Tewip answers carries its evidence and says what it did **not** check. It answers ' +
      '"cannot say" rather than guessing. `tewip --help` has all eleven commands when you want them.',
    '',
  );
  return lines.join('\n');
}

export function runStart(root: string): string {
  const where = resolve(root);
  const report = renderStart(lookAround(where), where);
  console.log(report);
  return report;
}
