---
name: check-a-migration
description: Use whenever a change adds or edits a database migration - SQL, Django, Rails or Alembic - or when someone asks whether a schema change is safe to deploy. Names what will break the version still running, destroy data, block writes, or cannot be undone, and finds code that still uses a column being dropped. Triggers on "migration", "schema change", "drop column", "add index", "alter table", "is this safe to deploy".
---

# What will this migration do to a live database?

The most expensive change in a pull request is usually not a test. It is a migration, and the damage is
done in the seconds between the migration running and the new code being everywhere:

- a column dropped while the previous deployment is still selecting it;
- an index built without `CONCURRENTLY`, blocking every write to the busiest table;
- a `NOT NULL` added to a populated table, scanning every row under a lock;
- a data migration holding a transaction open for an hour.

## What to call

**`what_will_this_migration_do`** with the project path and either a git range or the migration files.
It reads SQL, Django, Rails and Alembic, judges only the forward path, and searches the repository for
code that still uses what the migration takes away.

## How to read the answer

The sections are ordered by what they cost:

1. **Breaks the version that is still running** — stop here. This needs two releases: one that stops
   using the thing, one that removes it.
2. **Destroys data** — a drop or a truncate cannot be undone by deploying the old code again.
3. **Blocks writes while it runs** — usually fixable by the safe form the report names.
4. **Holds a long transaction** — depends on row count, which Tewip cannot see.

Two things it will not do, and you should not do either:

- **It will not guess a duration.** It cannot see table sizes or load, so it says what a statement does
  and leaves the timing to the person who knows the data. Do not invent a number for them.
- **The code search is evidence, not proof.** A match can be a comment or an unrelated name. Report it
  as "worth opening", which is what it is.

A migration it could not read is reported as unread. That is not a pass, and it must not be relayed as
one.

## What to tell the person

Lead with anything in the first two sections and the safe alternative the report gives. If the report is
clean, say that it was read and nothing in it breaks the running version - not simply "it looks fine".
