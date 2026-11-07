// Phase 51: `tewip secure`, measured for the first time against six real projects.
//
// The headline is not a false positive. It is that the command found secrets and reported none of
// them, in the default mode, which is every run without `--url`.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scanSecrets } from '../secure/secrets.ts';
import { scanSourceFiles, sourceFiles } from '../walk.ts';
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

describe('a credential is judged, not the URL around it', () => {
  // Measured on Saleor at its pinned commit. The report said "6 need someone now", every one high,
  // every one told to "revoke it at the issuer first". Three were the Django local-development
  // default in settings.py - postgres://saleor:saleor@localhost - one of them on a commented-out
  // line, and the evidence offered was that the value "has the randomness of a real credential
  // (3.82 bits per character)". That was measured over the whole URL, because the URL rules capture
  // the URL as group 1 and the password as group 2, and the scanner read group 1.
  const scan = (files: Record<string, string>) => {
    const root = project(files);
    return { root, found: scanSecrets(root, sourceFiles(root)) };
  };

  it('does not measure a password by the URL it sits in', () => {
    // `saleor` is six characters of nothing. It only passed the entropy gate because the gate was
    // reading `postgres://saleor:saleor@localhost:5432/saleor`.
    const { found } = scan({ 'settings.py': 'DATABASES = {"default": "postgres://saleor:saleor@localhost:5432/saleor"}\n' });
    assert.deepEqual(found, [], 'a six-letter password is not a credential, whatever the URL around it scores');
  });

  it('still reports a real password at a real host', () => {
    const { root, found } = scan({ '.env.production': 'DATABASE_URL=postgres://produser:hS8xQ2mZvEeMnOpQrStUvW@db.acme-prod.internal:5432/main\n' });
    assert.equal(found.length, 1);
    assert.equal(found[0].placeholder, null, 'a real host is not a stand-in');
    assert.equal(found[0].localOnly ?? null, null, 'a real host is not this machine');
    const [item] = found.map((f) => triageSecret(f, root, new Set()));
    // How urgent it is depends on whether the value is actually committed, which this fixture - a
    // bare directory, not a checkout - cannot say. What matters here is that it is not dismissed.
    assert.notEqual(item.verdict, 'noise');
  });

  it('does not let a word in the hostname dismiss a real password', () => {
    // The whole line contains "example", and it is in the host. Before this, the line test read it
    // as commentary and dropped a working credential into noise. Suppressing a real secret is the
    // worst thing this scanner can do, and it was one word in an unrelated part of the URL away.
    const { found } = scan({ '.env': 'DATABASE_URL=postgres://produser:hS8xQ2mZvEeMnOpQrStUvW@db.acme-prod.example-corp.io:5432/main\n' });
    assert.equal(found.length, 1);
    assert.equal(found[0].placeholder, null, 'the host is part of the credential, not a note about it');
  });

  it('calls a reserved domain what it is', () => {
    // example.com exists under RFC 2606 so that it cannot be anybody's system.
    const { found } = scan({ 'test_payloads.py': 'webhook.target_url = "http://someone:hS8xQ2mZvEeMnOpQrStUvW@example.com/webhooks"\n' });
    assert.match(found[0]?.placeholder ?? '', /reserved so that it cannot be anybody/);
  });

  it('calls a password identical to its username a stand-in', () => {
    const { found } = scan({ 'docker-compose.yml': '  DATABASE_URL: "postgres://hS8xQ2mZvEeMnOpQrStUvW:hS8xQ2mZvEeMnOpQrStUvW@db.real-host.io:5432/app"\n' });
    assert.match(found[0]?.placeholder ?? '', /the same word/);
  });

  it('puts a localhost credential where a person can still see it, without telling them to revoke it', () => {
    // Not noise: an earlier phase decided a hardcoded password in settings is worth a person
    // looking at, and that was right. Only the urgency was wrong - there is no issuer.
    const { root, found } = scan({ 'settings.py': 'DATABASES = {"default": "postgres://app:hS8xQ2mZvEeMnOpQrStUvW@localhost:5432/app"}\n' });
    const [item] = found.map((f) => triageSecret(f, root, new Set()));
    assert.equal(item.verdict, 'not-reachable');
    assert.notEqual(item.verdict, 'noise');
    assert.match(item.next, /nothing to revoke/);
    assert.doesNotMatch(item.next, /revoke it at the issuer/);
  });
});

// Phase 127: a scanner that told a password-manager team to revoke their software licence.
//
// Running `secrets` across the ten corpus repositories it had never seen produced exactly one
// "go and revoke this now" verdict, against Bitwarden's src/Core/Settings/GlobalSettings.cs. The
// value is a Duende IdentityServer product licence. Its own header says `"typ":"license+jwt"`
// and its payload is issued by duendesoftware.com to "Bitwarden Inc.". There is no issuer to
// revoke it at and no accident to clean up: it is meant to ship, in source.
//
// Tewip matched the shape of a JWT and never opened it. One of one real-risk findings was wrong.
const jwt = (typ: string | undefined, payload: Record<string, unknown> = { iss: 'https://example.test' }): string =>
  `${Buffer.from(JSON.stringify(typ === undefined ? { alg: 'PS256' } : { alg: 'PS256', typ })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlX2hlcmVfbG9uZ19lbm91Z2g`;

describe('a token that says what it is', () => {
  const findingFor = (value: string) => {
    const root = project({ 'src/settings.cs': `public string LicenseKey { get; set; } = "${value}";\n` });
    const found = scanSecrets(root, sourceFiles(root));
    return { root, finding: found[0] };
  };

  it('does not tell anyone to revoke a product licence', () => {
    const { root, finding } = findingFor(jwt('license+jwt', { iss: 'https://duendesoftware.com', company_name: 'Example Inc.' }));
    assert.ok(finding, 'the token is still found - it is committed, and that is worth seeing');
    const item = triageSecret(finding, root, new Set<string>());
    assert.notEqual(item.verdict, 'real-risk');
    assert.match(item.why, /"typ":"license\+jwt"/, 'the reason quotes the type, which is the evidence');
    assert.match(item.next, /nothing to revoke/);
  });

  it('still calls a verifiable credential a credential', () => {
    // The dangerous inversion, and the one I shipped first. The original rule asked "is this one
    // of the token types I recognise?" and treated every other type as harmless, which in a
    // security scanner gets the burden of proof backwards. Measured against keycloak it quietly
    // reclassified 38 tokens, among them vc+sd-jwt and dc+sd-jwt - verifiable credentials, by
    // name - and one fixture whose type is the word "unexpected".
    for (const typ of ['vc+sd-jwt', 'dc+sd-jwt', 'kb+jwt', 'unexpected', 'at+jwt']) {
      const { root, finding } = findingFor(jwt(typ));
      assert.ok(finding, `no finding for ${typ}`);
      assert.doesNotMatch(
        triageSecret(finding, root, new Set<string>()).why,
        /nothing to revoke|says what it is/,
        `a token typed ${typ} must not be waved through: not recognising a type is not the same as knowing it is safe`,
      );
    }
  });

  it('judges a token with no declared type exactly as before', () => {
    const { root, finding } = findingFor(jwt(undefined));
    assert.ok(finding);
    assert.doesNotMatch(triageSecret(finding, root, new Set<string>()).why, /says what it is/);
  });
});

// Phase 127, the second finding: the scan stops at 5,000 files and used to say nothing.
//
// On discourse that is 5,000 of 26,472 - nineteen per cent of the repository - reported as zero
// findings with "secrets in the working tree" listed under what was checked. A clean answer about
// a fifth of a project, in the report where a clean answer is worth most and justified least.
describe('a secret scan that stopped early says so', () => {
  const many = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (unused, i) => [`src/f${i}.ts`, `export const n${i} = ${i};\n`]));

  it('counts every file that qualified, not only the ones it read', () => {
    const root = project(many(40));
    const scan = scanSourceFiles(root, 10);
    assert.equal(scan.files.length, 10);
    assert.equal(scan.total, 40, 'the files past the limit are counted, or nobody can be told about them');
    assert.equal(scan.capped, true);
  });

  it('is not capped when it read everything', () => {
    const scan = scanSourceFiles(project(many(5)), 10);
    assert.equal(scan.capped, false);
    assert.equal(scan.total, scan.files.length);
  });

  it('names the unread files in the report, under what was not checked', async () => {
    // The first version of this called runSecure and then asserted on scanSourceFiles, which
    // tests the thing it is not named after - and runSecure had no limit to pass, so nothing was
    // capped at all. It passed, and proved nothing.
    const root = project(many(30));
    const printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void printed.push(args.join(' '));
    try {
      await runSecure({ root, secretsOnly: true, fileLimit: 10 });
    } finally {
      console.log = log;
    }
    const report = printed.join(String.fromCharCode(10));
    assert.match(report, /\*\*Not checked\*\*/);
    assert.match(report, /20 of 30 text file\(s\)/, 'the reader is told how many were never read');
    assert.match(report, /nothing here is known about the rest/);
  });
});

// Phase 127, third finding: the right verdict reached by the wrong reason.
//
// openmrs-core's release workflow writes `https://x-access-token:${GH_PUSH_TOKEN}@github.com/...`
// and Tewip dismissed it as "the value itself says it is an example". It says nothing of the
// kind. It says the value is substituted at run time, which is a stronger exoneration than
// looking fake - there is no credential in the file at all - and the reason is the part a reader
// checks before trusting the verdict.
describe('a credential that is a variable', () => {
  it('says the value is substituted, not that it looks like an example', () => {
    const root = project({ '.github/workflows/release.yaml': 'run: git remote set-url origin "https://x-access-token:${GH_PUSH_TOKEN}@github.com/acme/web.git"\n' });
    const [finding] = scanSecrets(root, sourceFiles(root));
    assert.ok(finding, 'the shape is still found');
    const item = triageSecret(finding, root, new Set<string>());
    assert.equal(item.verdict, 'noise');
    assert.match(item.why, /substituted at run time/);
    assert.doesNotMatch(item.why, /says it is an example/, 'a variable is not an example, and saying so is a reason that does not check out');
  });

  it('still calls a value that really does say "example" an example', () => {
    const root = project({ 'src/c.ts': 'const apiKey = "sk-example-not-a-real-key-000000000000";\n' });
    const [finding] = scanSecrets(root, sourceFiles(root));
    if (!finding) return; // the shape may not match; this guard is about not mislabelling, not about recall
    assert.match(triageSecret(finding, root, new Set<string>()).why, /example/);
  });
});

// Phase 132: a test resource explained as documentation.
//
// Keycloak keeps 30-odd SD-JWT test vectors in core/src/test/resources/sdjwt/*.txt. Because `.txt`
// reads as documentation, every one of them was explained as "the file is a template or
// documentation" - about files sitting under src/test/resources. The verdict and the severity are
// the same either way, so nobody was told to do the wrong thing; what was wrong is the sentence a
// reader checks before believing the verdict, which is the only part of a finding that can be
// audited. Found by reading all 99 findings across the four unpinned repositories.
describe('a file that is both a test and a document', () => {
  const inTest = () => project({ 'core/src/test/resources/sdjwt/s20.1-kb.txt': `eyJhbGciOiJFUzI1NiJ9.eyJfc2QiOlsiQ3JRZTdTNWtxQkFIdC1uTVlYZ2M2YnB4NVlfNWVfTlVhIl19.c2lnbmF0dXJlX2xvbmdfZW5vdWdoX2hlcmU${String.fromCharCode(10)}` });

  it('is explained as a test file, which is the truer half', () => {
    const root = inTest();
    const [finding] = scanSecrets(root, sourceFiles(root));
    assert.ok(finding, 'the token is found');
    const item = triageSecret(finding, root, new Set<string>());
    assert.match(item.why, /this is a test file/);
    assert.doesNotMatch(item.why, /template or documentation/, 'src/test/resources is not documentation');
  });

  it('does not change what the reader is told to do', () => {
    // The reason improved; the verdict must not move, or this is a behaviour change wearing a
    // wording change's clothes. Every verdict count across ten corpus repositories is unchanged.
    const root = inTest();
    const [finding] = scanSecrets(root, sourceFiles(root));
    const item = triageSecret(finding, root, new Set<string>());
    assert.equal(item.verdict, 'not-reachable');
    assert.equal(item.severity, 'medium');
  });

  it('still calls a real template a template', () => {
    // A JWT rather than a vendor-shaped key on purpose. The first version of this fixture used a
    // realistic `sk_live_...`, and GitHub's push protection refused the commit - correctly, and it
    // is the best review this file has had: a fixture written for a secret scanner was convincing
    // enough to trip a real one. A token with no `typ` is indistinguishable from a credential, so
    // it reaches the template branch, which is what this case is about.
    const root = project({ 'docs/example.env.txt': `API_TOKEN=${jwt(undefined)}${String.fromCharCode(10)}` });
    const [finding] = scanSecrets(root, sourceFiles(root));
    assert.ok(finding, 'the value must look like a credential, or this tests nothing');
    assert.match(triageSecret(finding, root, new Set<string>()).why, /template or documentation/);
  });
});

// Phase 147: the four shapes the recall measurement found missing.
//
// `secure` had a precision number and no recall number, which is the weaker half of a pair: a
// check that finds nothing scores perfect precision. eval/secure-recall.ts plants one credential
// per shape, each written from the format its provider publishes rather than from the patterns
// here, and reports what is missed.
//
// These four were missed. Each is added because its provider documents it, not because the eval
// asked - a pattern added to satisfy its own measurement makes the measurement worthless.
describe('shapes the recall measurement found missing', () => {
  const fake = (alphabet: string, n: number) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
  const hex = (n: number) => fake('0123456789abcdef', n);
  const b64 = (n: number) => fake('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', n);
  const kinds = (line: string) => scanSecrets(project({ 'src/config.ts': line })).map((f) => f.kind);

  it('finds a Shopify access token, in each of its prefixes', () => {
    for (const prefix of ['shpat_', 'shpca_', 'shppa_', 'shpss_']) {
      assert.ok(kinds(`const t = "${prefix}${hex(32)}";`).includes('shopify-token'), prefix);
    }
  });

  it('finds a Mailgun key', () => {
    assert.ok(kinds(`const mg = "key-${hex(32)}";`).includes('mailgun-key'));
  });

  it('finds an Azure storage key inside a connection string', () => {
    assert.ok(kinds(`const cs = "AccountName=orders;AccountKey=${b64(86)}==;Endpoint=x";`).includes('azure-storage-key'));
  });

  it('wants the name beside a Datadog key, because the shape alone is an md5', () => {
    // 32 hexadecimal characters is also a hash, a short object id, and half the entries in a
    // lockfile. On its own it is not a pattern, it is a false positive generator.
    assert.ok(kinds(`const c = { dd_api_key: "${hex(32)}" };`).includes('datadog-api-key'));
    assert.deepEqual(kinds(`const integrity = "${hex(32)}";`).filter((k) => k === 'datadog-api-key'), []);
  });
});
