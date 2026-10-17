// Phase 51: `tewip secure`, measured for the first time against six real projects.
//
// The headline is not a false positive. It is that the command found secrets and reported none of
// them, in the default mode, which is every run without `--url`.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scanSecrets, sourceFiles } from '../secure/secrets.ts';
import { triageSecret } from '../secure/triage.ts';
import { runSecure } from '../secure/secure-command.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-secure-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

// A real key shape, generated for this test and never used anywhere.
const KEY_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';

describe('a finding that reaches the report', () => {
  it('returns what it found, instead of emptying the list on the way out', async () => {
    // `reconcile` returns the array it was given when there is no web finding to reconcile against.
    // The caller then did `items.length = 0; items.push(...joined)` - and `joined` *was* `items`, so
    // it emptied the very array it was about to copy back in. Every secret found was discarded
    // between finding it and reporting it, and the report said "0 need someone now", which is also
    // what a clean repository says. Keycloak: 49 located, 7 triaged as real risks, none reported.
    const root = project({ 'config.py': `DB = "postgres://admin:hunter2abcdef@db.internal:5432/app"\n` });
    const items = await runSecure({ root, secretsOnly: true });
    assert.ok(items.length > 0, 'the scan found something and the command returned nothing');
    assert.equal(scanSecrets(root, sourceFiles(root)).length, items.length, 'every finding reaches the report');
  });
});

describe('what a secret scanner must not cry wolf about', () => {
  const findingIn = (files: Record<string, string>) => {
    const root = project(files);
    const found = scanSecrets(root, sourceFiles(root));
    return { root, found };
  };

  it('does not read a PEM header constant as a private key', () => {
    // Keycloak's PemUtils.java declares `BEGIN_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----"` so that
    // it can recognise one. There is no key on that line, and Tewip told Red Hat it had leaked two.
    const { found } = findingIn({ 'PemUtils.java': 'public static final String BEGIN_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----";\n' });
    assert.deepEqual(found.filter((f) => f.kind === 'private-key'), []);
  });

  it('still reads a header with a key under it', () => {
    const { found } = findingIn({ 'id_rsa': `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n` });
    assert.equal(found.filter((f) => f.kind === 'private-key').length, 1);
  });

  it('does not say "act now" about a key a test file keeps on purpose', () => {
    // PemUtilsTest.java carries three keypairs so that it can test reading keypairs. Calling those
    // "needs someone now" buries the one finding that might not be a fixture under six that are.
    const { root, found } = findingIn({ 'core/src/test/java/PemUtilsTest.java': `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n` });
    const [item] = found.map((f) => triageSecret(f, root, new Set()));
    assert.equal(item?.verdict, 'not-reachable');
    assert.match(item?.why ?? '', /test file/);
  });

  it('reads the key above a value, not only the line it is on', () => {
    // JSON puts the key on its own line when the value is long, and an OpenAPI schema is all long
    // values. Reading only the token's line found nothing.
    const { found } = findingIn({ 'conf.json': '{\n  "example":\n    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.aGVsbG93b3JsZGhlbGxv"\n}\n' });
    assert.ok(found.every((f) => f.placeholder), 'the key above it says it is an example');
  });

  it('treats an OpenAPI schema as the documentation it is', () => {
    // nocodb nests its sample tokens three deep under "Example 1", too far for a one-line lookback.
    const { root, found } = findingIn({ 'swagger.json': '{\n "Example 1": {\n  "value": {\n   "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.aGVsbG93b3JsZGhlbGxv"\n  }\n }\n}\n' });
    const verdicts = found.map((f) => triageSecret(f, root, new Set()).verdict);
    assert.ok(!verdicts.includes('real-risk'), 'an example in an API schema is not a leak');
  });

  it('still calls a hardcoded credential in settings what it is', () => {
    // saleor's settings.py defaults to postgres://saleor:saleor@localhost, and bitwarden ships a
    // signed licence key in GlobalSettings.cs. Both are worth a person looking at.
    const { root, found } = findingIn({ 'settings.py': 'DATABASES = {"default": "postgres://saleor:saleorpassword@localhost:5432/saleor"}\n' });
    const [item] = found.map((f) => triageSecret(f, root, new Set()));
    assert.ok(item, 'a credential in settings is still found');
    assert.notEqual(item?.verdict, 'noise');
  });
});
