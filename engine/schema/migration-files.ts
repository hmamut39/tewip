// Which files in a project are migrations at all.
//
// Split out of schema-command.ts in Phase 44, when the corpus harness needed to ask the question
// across a whole checkout rather than across a diff and that file went past the 300-line rule.
// Keeping it in one place is the point: the alternative was a copy of these patterns in a script,
// and two definitions of "is this a migration" drift the moment one of them is fixed.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// A directory called `migration/` says what is probably in it, not what every file in it is. This
// matched *anything* underneath one, so Keycloak's `docs/guides/migration/index.adoc` and its 113
// `migration/migrators/MigrateTo12_0_0.java` classes - application code that moves data between
// Keycloak versions, nothing to do with a schema file - were selected as migrations and then listed
// as ones Tewip could not read. 205 files chosen in order to read 89. A "could not read" list that
// is mostly documentation teaches the reader to skip the list.
//
// So the directory decides *where*, and the extension decides *whether it could hold DDL at all*.
const MIGRATION_DIR = /(^|\/)(migrations?|migration|db\/migrate|prisma\/migrations|alembic|flyway|changelogs?|sql)\//i;
const COULD_HOLD_DDL = /\.(sql|py|rb|js|mjs|cjs|ts|php|cs|xml|ya?ml|json|go|exs?)$/i;
// Flyway's Java migrations are real, and they are named the way Flyway requires: `V2__add_index.java`
// or `R__rebuild_views.java`. Keycloak's `MigrateTo12_0_0.java` is not one. Taking `.java` on the
// strength of its directory alone is what filled that list with source files.
const FLYWAY_JAVA = /(^|\/)[VR][\w.]*__[\w.-]+\.(java|kt|scala)$/;

export const MIGRATION = {
  test: (path: string): boolean => MIGRATION_DIR.test(path) && (COULD_HOLD_DDL.test(path) || FLYWAY_JAVA.test(path)),
};

// A changelog is often not in a directory that says so. OpenMRS keeps 44 Liquibase changelogs in
// `api/src/main/resources/` named `liquibase-*.xml`, and the path filter saw none of them - so a
// real healthcare system with 44 migration files was told it had none. The name counts too.
//
// And a changelog is named for what it is, but hardly ever *only* that. Phase 42 taught this filter
// to read `liquibase-update-to-latest.xml` and it still missed Keycloak's 83, every one called
// `jpa-changelog-<version>.xml`: the word had to *begin* the name. Prefixes are the norm once a
// project has more than one database. Letting a release-notes `CHANGELOG.xml` through costs nothing,
// because `dialectOf` still has to find `<databaseChangeLog` in it before it is read as a migration.
export const NAMED_MIGRATION = /(^|\/)[\w.-]*(liquibase|changelog)[\w.-]*\.(xml|ya?ml|json)$/i;
export const SCHEMA_FILE = /\.(sql)$|(^|\/)(migrations?|migration|db\/migrate)\/.*\.(py|rb|js|ts|php|cs)$/i;

/**
 * Every migration in a whole repository, by the same filters a diff is read through.
 *
 * `schemaFiles` answers "which of these changed files are migrations", which is the question a pull
 * request asks. "What migrations does this project have at all" is a different question, and the
 * corpus harness needs it to re-derive a verified number across a pinned checkout.
 */
export function migrationsUnder(root: string, limit = 20_000): string[] {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.cache']);
  const found: string[] = [];
  const walk = (where: string, depth: number): void => {
    if (depth > 12 || found.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(where);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry) || entry.startsWith('.')) continue;
      const full = join(where, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const rel = relative(root, full).replaceAll(String.fromCharCode(92), '/');
      if (SCHEMA_FILE.test(rel) || MIGRATION.test(rel) || NAMED_MIGRATION.test(rel)) found.push(rel);
    }
  };
  walk(root, 0);
  return found.sort();
}
