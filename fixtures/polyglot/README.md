# Polyglot fixtures

One tiny test project per language, each with the same four tests: one passes, one fails on a
wrong value (expected 4, got 3), one fails because a service is unreachable (connection refused
on 127.0.0.1:9), and, where the runner supports retries, one fails once and passes on the retry.

`.github/workflows/polyglot-fixtures.yml` runs each with its real test runner and uploads the
reports, so the JUnit/TRX importer is checked against what those runners actually write rather
than hand-made samples. These are not product tests and are not run by `npm test`.
