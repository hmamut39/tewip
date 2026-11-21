// How much `tewip secure` finds, measured by planting credentials it was not written against.
//
// The precision claim has been measurable for a long time: zero findings across 18,617 files of
// real code. On its own that number is worth very little, because a check that finds nothing
// scores it perfectly. The question a buyer asks second is the one this answers.
//
// The measurement is only worth having if the planting is independent of the detector, so the
// shapes below are written from **what each provider documents about its own tokens** - the prefix
// and the length AWS, GitHub, Stripe and the rest publish - and not from Tewip's patterns. Where
// the two agree, that is the detector being right rather than the test being circular. Where they
// disagree, the miss is real and is listed by name.
//
// Nothing here is a credential. Every value is assembled at run time from a seeded generator, so
// this file contains formats and no secrets, it is safe to commit, and the same seed gives the
// same run twice. Nothing is written inside the repository and nothing is ever printed in full.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanSecrets } from '../engine/secure/secrets.ts';
import { triageSecret } from '../engine/secure/triage.ts';

const NL = String.fromCharCode(10);

/** A seeded generator, so a run is reproducible and no value is ever a real key by accident. */
function generator(seed: number): (alphabet: string, length: number) => string {
  let state = seed >>> 0;
  return (alphabet, length) => {
    let out = '';
    for (let i = 0; i < length; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      out += alphabet[state % alphabet.length];
    }
    return out;
  };
}

const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
const B64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';

interface Shape {
  kind: string;
  /** The provider's own documented format, in words, so a reader can check the generator. */
  documented: string;
  build: (r: ReturnType<typeof generator>) => string;
  /** Where it is planted, when the verdict depends on the kind of file it sits in. */
  at?: string;
}

/**
 * One entry per credential shape, written from the provider's documentation.
 *
 * Deliberately wider than what Tewip recognises: a list limited to the patterns already in
 * `secrets.ts` would measure nothing. The ones it misses are the result.
 */
const SHAPES: Shape[] = [
  { kind: 'aws-access-key-id', documented: 'AKIA followed by 16 uppercase alphanumerics', build: (r) => 'AKIA' + r(UPPER_NUM, 16) },
  { kind: 'github-token', documented: 'ghp_ followed by 36 alphanumerics', build: (r) => 'ghp_' + r(ALNUM, 36) },
  { kind: 'github-fine-grained', documented: 'github_pat_ followed by 82 characters', build: (r) => 'github_pat_' + r(ALNUM, 82) },
  { kind: 'gitlab-token', documented: 'glpat- followed by 20 characters', build: (r) => 'glpat-' + r(ALNUM, 20) },
  { kind: 'slack-token', documented: 'xoxb- then two number groups then a secret', build: (r) => 'xoxb-' + r('0123456789', 12) + '-' + r('0123456789', 12) + '-' + r(ALNUM, 24) },
  { kind: 'stripe-key', documented: 'sk_live_ followed by 24 alphanumerics', build: (r) => 'sk_' + 'live_' + r(ALNUM, 24) },
  { kind: 'openai-key', documented: 'sk- followed by 48 characters', build: (r) => 'sk-' + r(ALNUM, 48) },
  { kind: 'anthropic-key', documented: 'sk-ant-api03- followed by 95 characters', build: (r) => 'sk-ant-api03-' + r(ALNUM, 95) },
  { kind: 'google-api-key', documented: 'AIza followed by 35 characters', build: (r) => 'AIza' + r(ALNUM, 35) },
  { kind: 'npm-token', documented: 'npm_ followed by 36 alphanumerics', build: (r) => 'npm_' + r(ALNUM, 36) },
  { kind: 'sendgrid-key', documented: 'SG. then 22 characters then a dot then 43', build: (r) => 'SG.' + r(ALNUM, 22) + '.' + r(ALNUM, 43) },
  { kind: 'twilio-api-key', documented: 'SK followed by 32 hexadecimal characters', build: (r) => 'SK' + r(HEX, 32) },
  { kind: 'shopify-token', documented: 'shpat_ followed by 32 hexadecimal characters', build: (r) => 'shpat_' + r(HEX, 32) },
  { kind: 'mailgun-key', documented: 'key- followed by 32 hexadecimal characters', build: (r) => 'key-' + r(HEX, 32) },
  { kind: 'datadog-api-key', documented: '32 hexadecimal characters under a named key', build: (r) => r(HEX, 32) },
  { kind: 'azure-storage-key', documented: 'AccountKey= followed by 88 base64 characters', build: (r) => 'AccountKey=' + r(B64, 86) + '==' },
  { kind: 'private-key', documented: 'a PEM block', build: (r) => '-----BEGIN RSA PRIVATE KEY-----' + NL + r(B64, 64) + NL + '-----END RSA PRIVATE KEY-----' },
  { kind: 'postgres-url', documented: 'a connection string carrying a password', build: (r) => 'postgres://admin:' + r(ALNUM, 24) + '@db.internal:5432/orders' },
  // Both of the first two segments begin `eyJ`, because each is base64url of an object and `{"`
  // encodes to exactly that. Written with a random payload this missed, and the miss was the
  // generator being unrealistic rather than Tewip having no pattern - which is what hand-checking
  // a miss is for.
  { kind: 'jwt', documented: 'three base64url segments, the first two beginning eyJ', build: (r) => 'eyJhbGciOiJIUzI1NiJ9.eyJ' + r(ALNUM, 40) + '.' + r(ALNUM, 43) },
  // Not example.com: that domain is reserved by RFC 2606 precisely so it cannot be anybody's
  // system, and Tewip says so and declines to raise it. Written against example.com this scored
  // as a miss, and the miss was the generator picking a documentation host.
  { kind: 'basic-auth-url', documented: 'a URL carrying a user and password', build: (r) => 'https://svc:' + r(ALNUM, 20) + '@payments.acme-corp.io/api' },
];

/**
 * Things that look like credentials and are not.
 *
 * Planted beside the real shapes so the same run reports what it wrongly accuses. A recall number
 * with no precision number beside it can be bought by reporting everything.
 */
const DECOYS: Shape[] = [
  { kind: 'uuid', documented: 'a UUID', build: (r) => `${r(HEX, 8)}-${r(HEX, 4)}-4${r(HEX, 3)}-a${r(HEX, 3)}-${r(HEX, 12)}` },
  { kind: 'git-sha', documented: 'a commit hash', build: (r) => r(HEX, 40) },
  { kind: 'base64-blob', documented: 'an encoded image', build: (r) => 'data:image/png;base64,' + r(B64, 120) },
  { kind: 'lorem', documented: 'a long sentence', build: () => 'The quick brown fox jumps over the lazy dog again and again and again' },
  { kind: 'placeholder', documented: 'an obvious example value', build: () => 'sk_test_' + 'EXAMPLE_KEY_DO_NOT_USE_0000' },
  // Phase 210, from immich's own documentation:
  //
  //     DB_URL='postgresql://immichdbusername:immichdbpassword@postgreshost:postgresport/db'
  //
  // Every part names what it is, which a person sees instantly. Tewip called it "a database URL
  // with a password in it" and explained that "the value itself does not say it is an example" -
  // about a value that is the word `immichdbpassword`. Four of the five findings on immich were
  // that one sentence.
  { kind: 'self-describing', documented: 'a value that is the word for what it is, in documentation', at: 'docs/self-describing.md', build: () => 'immichdbpassword' },
  { kind: 'self-describing-url', documented: 'a documented connection string, all placeholders', at: 'docs/self-describing-url.md', build: () => ['postgresql://immichdbusername', 'immichdbpassword@postgreshost:postgresport/immichdatabasename'].join(':') },
];

/**
 * Real credentials that must stay found, however much they look like the word for what they are.
 *
 * The rule added in Phase 210 asks only about the value, and only about a value that is nothing but
 * letters - because `PLACEHOLDER_WORDS` is tested against the surrounding line too, so putting
 * `password` in that list would have dismissed every real `password = "..."` assignment there is.
 * These are the cases that would catch that mistake: each is a plausible password sitting on a line
 * that says the word.
 */
const PASSWORDS: Shape[] = [
  { kind: 'password-random', documented: 'a real password in a connection string', build: (r) => `postgresql://appuser:${r('abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', 20)}@db.prod.internal/orders` },
  { kind: 'password-words', documented: 'a weak but real password of plain words', build: () => ['mongodb://svc', 'correcthorsebatterystaple@cluster0.acme.io/app'].join(':') },
  { kind: 'password-in-http', documented: 'a real password inside an http URL', build: (r) => `https://deploy:${r('abcdefghijkmnopqrstuvwxyz23456789', 18)}@artifacts.acme.io/repo` },
  // The two that keep the rule narrow, and neither was here until the sabotage run showed that
  // taking the narrowness away cost nothing:
  //
  //   the user is called `secretsvc`, so the URL *contains* the word - only a value that is
  //   nothing but those words may be dismissed, never one that merely holds one;
  //   every line here already reads `const password_… =`, because `planted()` names the variable
  //   after the case - so putting `password` in PLACEHOLDER_WORDS, which is tested against the
  //   surrounding line, would throw all of these away.
  { kind: 'password-user-says-secret', documented: 'a real password whose URL names a user called secretsvc', build: (r) => `postgresql://secretsvc:${r('abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', 20)}@db.prod.internal/app` },
  { kind: 'password-host-says-token', documented: 'a real password at a host with token in its name', build: (r) => `https://ci:${r('abcdefghijkmnopqrstuvwxyz23456789', 18)}@token-service.acme.io/fetch` },
];

/** The line a credential is written on in real code: an assignment in a config file. */
const planted = (kind: string, value: string): string =>
  [`// ${kind} for the orders service`, `const ${kind.replace(/-/g, '_')} = "${value}";`, 'export default { timeout: 30 };'].join(NL);

/** A credential whose shape alone says nothing is written the way its provider's SDK writes it. */
const NAMED: Record<string, (value: string) => string> = {
  'datadog-api-key': (v) => `const config = { dd_api_key: "${v}", site: "datadoghq.eu" };`,
  'azure-storage-key': (v) => `const cs = "DefaultEndpointsProtocol=https;AccountName=orders;${v};EndpointSuffix=core.windows.net";`,
};

export interface Measured {
  kind: string;
  documented: string;
  /** Did any pattern match it at all. */
  matched: boolean;
  /** Did triage keep it as something a person must act on. */
  actionable: boolean;
  /** The verdict itself, because noise and not-reachable are different answers. */
  verdict: string;
}

/**
 * A working credential pasted into a documentation file, which must stay visible.
 *
 * triage.ts calls this "the commonest accident there is - a working key pasted into an example
 * file", and shows it below the ones needing action rather than dismissing it. The placeholder rule
 * added in Phase 210 fires only inside these files, so this is where it can do harm: the verdict
 * here must stay `not-reachable`, never `noise`, however much the surrounding words talk about
 * secrets. The user is called `secretsvc` and the password itself begins with the word, both on purpose: the
 * rule must look at the value and must refuse to fire on one carrying digits and capitals.
 */
const IN_DOCS: Shape[] = [
  {
    kind: 'real-key-in-docs',
    documented: 'a real credential in documentation, beside the word secret',
    at: 'docs/real-key-in-docs.md',
    build: (r) => `postgresql://secretsvc:secret${r('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 18)}@db.prod.internal/app`,
  },
];

export function measure(seed = 7): { credentials: Measured[]; decoys: Measured[]; inDocs: Measured[] } {
  const root = mkdtempSync(join(tmpdir(), 'tewip-secure-recall-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    const r = generator(seed);
    const values = new Map<string, string>();
    for (const shape of [...SHAPES, ...PASSWORDS, ...DECOYS, ...IN_DOCS]) {
      const value = shape.build(r);
      values.set(shape.kind, value);
      const body = NAMED[shape.kind]?.(value) ?? planted(shape.kind, value);
      const at = shape.at ?? `src/${shape.kind}.ts`;
      mkdirSync(join(root, dirname(at)), { recursive: true });
      writeFileSync(join(root, at), body, 'utf8');
    }
    // Committed, because triage asks whether a credential ever left the machine and answers that
    // from git. In a directory git does not track, every finding is correctly `not-reachable` - the
    // first run of this scored Tewip 0 of 20 on exactly that, which was the harness being wrong
    // and the triage being right. These are generated fakes in a throwaway repository that is
    // never pushed anywhere.
    const quiet = { cwd: root, stdio: 'ignore' as const };
    execFileSync('git', ['init', '-q'], quiet);
    execFileSync('git', ['add', '-A'], quiet);
    execFileSync('git', ['-c', 'user.email=eval@tewip', '-c', 'user.name=eval', 'commit', '-qm', 'planted'], quiet);

    const found = scanSecrets(root);
    const judge = (shape: Shape): Measured => {
      const here = found.filter((f) => f.file.includes(shape.kind));
      return {
        kind: shape.kind,
        documented: shape.documented,
        matched: here.length > 0,
        actionable: here.some((f) => triageSecret(f, root, new Set<string>()).verdict === 'real-risk'),
        verdict: here.map((f) => triageSecret(f, root, new Set<string>()).verdict)[0] ?? 'none',
      };
    };
    return { credentials: [...SHAPES, ...PASSWORDS].map(judge), decoys: DECOYS.map(judge), inDocs: IN_DOCS.map(judge) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function report(): void {
  const { credentials, decoys, inDocs } = measure();
  const matched = credentials.filter((c) => c.matched);
  const actionable = credentials.filter((c) => c.actionable);
  const missed = credentials.filter((c) => !c.matched);
  const accused = decoys.filter((d) => d.actionable);
  const matchedDecoys = decoys.filter((d) => d.matched);
  const misjudged = matchedDecoys.filter((d) => d.verdict !== 'noise');
  const buried = inDocs.filter((d) => d.verdict !== 'not-reachable');
  const pct = (n: number) => `${((n / credentials.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      '# secure, measured by planting what the providers document',
      '',
      `${credentials.length} credential shapes, each written from the provider's own documented format rather than`,
      "from Tewip's patterns, planted one per file in a throwaway project.",
      '',
      `Matched by some pattern:              ${matched.length} of ${credentials.length} (${pct(matched.length)})`,
      `Kept by triage as needing action:     ${actionable.length} of ${credentials.length} (${pct(actionable.length)})`,
      '',
      '## The ones it did not find',
      '',
      ...(missed.length === 0 ? ['None.'] : missed.map((m) => `- **${m.kind}** — ${m.documented}`)),
      '',
      '## Found but not called actionable',
      '',
      ...(() => {
        const quiet = credentials.filter((c) => c.matched && !c.actionable);
        return quiet.length === 0 ? ['None.'] : quiet.map((q) => `- **${q.kind}** — matched a pattern, triaged as noise`);
      })(),
      '',
      '## What it wrongly accused',
      '',
      `${decoys.length} decoys planted beside them - a UUID, a commit hash, an encoded image, a sentence, an`,
      'obvious placeholder. A recall number with no precision beside it can be bought by reporting',
      'everything.',
      '',
      ...(accused.length === 0 ? ['None of them was called a credential needing action.'] : accused.map((a) => `- **${a.kind}** — ${a.documented}`)),
      '',
      // Not enough on its own, and this harness said so the moment it was asked properly. "Needing
      // action" is one bit, and the rule added in Phase 210 moves a finding between two answers
      // that are both *not* actionable - `noise` ("this is not a credential") and `not-reachable`
      // ("real, but not of what it runs"). Taking the rule away changed no number here until the
      // verdict itself was measured.
      `Decoys matched by a pattern and then read correctly as noise: ${matchedDecoys.length - misjudged.length} of ${matchedDecoys.length}`,
      `Real credentials in documentation, kept visible rather than dismissed: ${inDocs.length - buried.length} of ${inDocs.length}`,
      ...(buried.length === 0 ? [] : buried.map((b) => `- **${b.kind}** — called \`${b.verdict}\`, so a working key in an example file was dismissed`)),
      ...(misjudged.length === 0 ? [] : misjudged.map((m) => `- **${m.kind}** — called \`${m.verdict}\`, which is not "this is not a credential"`)),
      '',
      '---',
      '',
      'What this rests on: the shapes are the published formats, so a miss here is a shape Tewip has',
      'no pattern for rather than a trick. What it does not measure is a credential in a shape nobody',
      'publishes - an internal token, a password in a config file with no recognisable form - which',
      'no pattern-based scanner finds and which this cannot pretend to cover. A bare',
      '`password = "..."` assignment is in that class on purpose: there is no pattern for it, because',
      'every string assigned to a variable called password would match one.',
      '',
      'Phase 210 added the rule that a value which is **the word for what it is** - `immichdbpassword`',
      "- is a placeholder. On immich that took the findings needing a second look from 5 to 1, and the",
      'one left is a real PEM key in a file called test-keys.ts, which should stay. The rule is kept',
      'narrow deliberately, and the narrowness is measured rather than asserted: three sabotages, all',
      'three caught, and the telling one is putting `password` into `PLACEHOLDER_WORDS` - which is',
      'tested against the surrounding line as well as the value. Every case here is written',
      '`const password_… = "<credential>"`, so that one change takes this harness from **25 of 25 to',
      '15 of 25**: ten real credentials dismissed to tidy up a documentation example.',
      '',
    ].join(NL),
  );
}

// `import.meta.main`, not a substring of argv[1]: a test file named after this harness
// made `process.argv[1].includes('secure-recall')` true, so importing it to read its exports ran the
// whole measurement - minutes of work, on a module that was only being imported.
if (import.meta.main) report();
