Phase 51: secure found secrets and reported none of them

Twenty-nine verbs had never had a field trial. secure was chosen because
its failure mode is the most expensive one there is - telling a team they
have committed a credential - and because the corpus holds a password
manager and an identity server, both full of fixtures that look like leaks.

The headline is not a false positive. On Keycloak the scanner located 49
secrets, triage ranked 7 of them as real risks, and the report said "0 need
someone now". reconcile returns the array it was handed when there is no web
finding to reconcile against, and the caller then did items.length = 0
followed by items.push(...joined) - where joined *was* items. Every finding
was discarded between being found and being reported, on every run without
--url, which is almost every run. A zero here reads exactly like a clean
repository. Phase 50 said it four days ago: a zero is the hardest wrong
answer to notice, because it looks like the answer you wanted.

With the findings flowing, four false-positive classes had to go, each one
verified by hand against the source:

- A PEM header with no key under it. PemUtils.java declares BEGIN_PRIVATE_KEY
  so Keycloak can recognise a key; the pattern matched the header alone and
  Tewip told Red Hat it had leaked two keys that do not exist.
- Keys a test file keeps on purpose. PemUtilsTest.java carries three keypairs
  in order to test reading keypairs. Shown, but below what needs acting on.
- A value whose key sits on the line above it, which is how JSON writes a
  long value.
- OpenAPI schemas, where nocodb nests sample tokens three deep under
  "Example 1" - too far for any lookback, so the file name decides.

Keycloak went from 7 "needs someone now" to 0 and nocodb from 5 to 0. Nine
findings survive across six projects and all are defensible: saleor defaults
to postgres://saleor:saleor@localhost in settings.py, bitwarden ships a
signed licence key in GlobalSettings.cs, the rest are CI credentials.

993 tests.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>