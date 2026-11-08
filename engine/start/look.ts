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
import { isDockerfile } from '../iac/dockerfile.ts';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.cache', '.tewip', '.triage-agent']);

export interface Found {
  /** Test files, by the language they are written in. */
  tests: Map<string, number>;
  /** Migrations, by the tool that wrote them. */
  migrations: Map<string, number>;
  markup: number;
  /** Dependency manifests, by the ecosystem that owns them. */
  manifests: Map<string, number>;
  /** Dockerfiles, because what the container adds is in no lockfile. */
  containers: number;
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
    manifests: new Map(),
    containers: 0,
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

      // By name alone, costing nothing: this loop already has the entry and the evidence pack only
      // needs to know an ecosystem is here, not what is in it.
      //
      // Fixtures excluded, and they have to be: five of the seven manifests in Tewip's own
      // repository are under `fixtures/polyglot`, so the front door announced it as a .NET, Go,
      // Java and Ruby project on the strength of its own test data. Test *files* are still counted,
      // because naming them is the point of the `vouch` suggestion - it is only the claim "this
      // project depends on X" that a fixture must not be allowed to make.
      if (!SOMEBODY_ELSES_EXAMPLE.test(rel)) {
        const ecosystem = ECOSYSTEM_OF(entry);
        if (ecosystem) found.manifests.set(ecosystem, (found.manifests.get(ecosystem) ?? 0) + 1);
        if (isDockerfile(entry)) found.containers += 1;
      }

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

export interface Suggestion {
  command: string;
  because: string;
}

export const total = (counts: Map<string, number>): number => [...counts.values()].reduce((a, b) => a + b, 0);

/** What a person calls these, rather than what the code calls them. */
export const PLAIN: Record<string, string> = {
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

/**
 * Which ecosystem a filename belongs to, for the front door only.
 *
 * Not the same question `sbom` answers - that one reads the file and reports what it cannot read.
 * This only needs to know whether there is anything for the evidence pack to say, which a name
 * settles. Kept deliberately short: a manifest nobody recognises is simply not mentioned here, and
 * the pack itself will still name it as a gap.
 */
const SOMEBODY_ELSES_EXAMPLE = /(^|\/)(?:fixtures?|examples?|samples?|demos?|templates?|testdata|__mocks__|e2e)(\/|$)/i;

const ECOSYSTEM_OF = (name: string): string | null => {
  if (name === 'package.json') return 'npm';
  if (name === 'requirements.txt' || name === 'pyproject.toml') return 'pypi';
  if (name === 'go.mod') return 'go';
  if (name === 'Cargo.toml') return 'cargo';
  if (name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts') return 'maven';
  if (name === 'Gemfile') return 'rubygems';
  if (name === 'composer.json') return 'composer';
  if (/\.(?:cs|fs|vb)proj$/.test(name)) return 'nuget';
  return null;
};

export const named = (counts: Map<string, number>): string =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    // Only the ones worth naming: a repository with one stray file in a ninth language does not
    // need all nine listed at the front door.
    .slice(0, 3)
    .map(([name, n]) => `${n} ${PLAIN[name] ?? name}`)
    .join(', ');
