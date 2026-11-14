// The README tells an IT department that five commands call no model and send nothing off the
// machine. This runs them with every door out of the process shut, and fails if one is opened.
//
// That sentence is the load-bearing one in the whole document. A count being wrong costs the
// project a little credibility; "nothing leaves the machine" being wrong is the thing somebody
// relied on when they ran it over a private repository. It was in the README unverified, next to a
// test asserting that `tewip` *prints* "no model was called" - which checks the wording of the
// claim and not the behaviour behind it.
//
// Two details decide whether this test means anything:
//
//   1. `OPENAI_API_KEY` is set to a real-looking value. With it empty, every "call the model if a
//      key is present" branch is skipped and all five commands pass for the wrong reason - the
//      shape that made an earlier test pass because `SLOWEST_FIRST` happened to be complete.
//   2. The doors are shut by replacement, not recorded. A mock that logs the call and lets it
//      through proves nothing: the packet left. `no-network.ts` throws instead, and the first test
//      below proves each of its eight doors is actually shut, because a preload that silently
//      fails to patch something would make every test here pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { REACHED_OUT } from './no-network.ts';
import { lf } from '../lines.ts';

const ROOT = join(import.meta.dirname, '..', '..');
// A file:// URL, not a path: `--import c:\...` is rejected by the ESM loader on Windows, and a
// plain path that happens to work on Linux is how this suite has twice shipped a Windows-only
// or Linux-only failure. `pathToFileURL` is right on both.
const PRELOAD = pathToFileURL(join(ROOT, 'engine', 'test', 'no-network.ts')).href;
const NL = String.fromCharCode(10);

/** A plain project with a lockfile, a container and a source file, for the commands to read. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tewip-rules-only-'));
  const app = join(dir, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: {} }), 'utf8');
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, packages: {} }), 'utf8');
  writeFileSync(join(app, 'src', 'index.js'), 'export const hello = () => "hi";' + NL, 'utf8');
  writeFileSync(join(app, 'Dockerfile'), ['FROM node:latest', 'COPY . /app'].join(NL) + NL, 'utf8');
  writeFileSync(join(app, 'compose.yaml'), ['services:', '  app:', '    privileged: true'].join(NL) + NL, 'utf8');
  return dir;
}

function run(args: string[], cwd: string): { out: string; code: number | null } {
  const r = spawnSync(process.execPath, ['--import', PRELOAD, join(ROOT, 'cli', 'tewip.ts'), ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      // Non-empty on purpose, and no longer than it needs to be. `engine/llm/providers.ts` asks
      // only whether the trimmed value is non-empty, so this is enough to make the "a key is
      // present, call the model" branch live - and an empty key would make this whole test vacuous.
      // The first version was 46 characters after `sk-`, which matched this project's own
      // `openai-key` pattern (32 or more) in its own test file. `secure` read it as noise and was
      // right to, but a placeholder that needs a scanner's judgement is a placeholder written
      // badly. Setting it here also overrides any real key in the parent environment, so the
      // child process cannot be handed one.
      OPENAI_API_KEY: 'not-a-real-key',
      TEWIP_NO_UPDATE_CHECK: '1',
    },
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status };
}

describe('the preload that shuts the network', () => {
  it('shuts every door it claims to, so the tests below cannot pass vacuously', () => {
    const probe = join(mkdtempSync(join(tmpdir(), 'tewip-doors-')), 'probe.ts');
    writeFileSync(
      probe,
      [
        "import dns from 'node:dns';",
        "import http from 'node:http';",
        "import https from 'node:https';",
        "import net from 'node:net';",
        "import tls from 'node:tls';",
        'const doors: Array<[string, () => unknown]> = [',
        "  ['fetch', () => fetch('https://example.com')],",
        "  ['https.get', () => https.get('https://example.com')],",
        "  ['https.request', () => https.request('https://example.com')],",
        "  ['http.request', () => http.request('http://example.com')],",
        "  ['net.connect', () => net.connect(80, 'example.com')],",
        "  ['net.createConnection', () => net.createConnection(80, 'example.com')],",
        "  ['tls.connect', () => tls.connect(443, 'example.com')],",
        "  ['dns.lookup', () => dns.lookup('example.com', () => {})],",
        '];',
        'for (const [name, open] of doors) {',
        '  try {',
        '    open();',
        '    console.log(`OPEN ${name}`);',
        '  } catch (e) {',
        "    console.log(`${String((e as Error).message).includes('" + REACHED_OUT + "') ? 'SHUT' : 'OTHER'} ${name}`);",
        '  }',
        '}',
        "console.log(`INSTALLED ${((globalThis as { __tewipShut?: string[] }).__tewipShut ?? []).join(',')}`);",
      ].join(NL),
      'utf8',
    );
    const r = spawnSync(process.execPath, ['--import', PRELOAD, probe], { encoding: 'utf8' });
    const all = (r.stdout ?? '').trim().split(NL).filter(Boolean);
    const installed = (all.find((l) => l.startsWith('INSTALLED '))?.slice('INSTALLED '.length) ?? '').split(',').filter(Boolean);
    const lines = all.filter((l) => !l.startsWith('INSTALLED '));
    assert.equal(lines.length, 8, `the probe reported ${lines.length} doors, not 8: ${r.stdout}${r.stderr}`);

    // Each patch is checked for individually, because behaviour alone cannot see them all: delete
    // the `tls.connect` patch and nothing changes, since `tls.connect` goes through `net.connect`
    // and that one is still shut. A door shut by a different door's patch is a door that comes open
    // the moment the other one moves, and the test watching only for a throw would never say so.
    assert.deepEqual(
      installed.sort(),
      [
        'dns.lookup',
        'dns.promises.lookup',
        'dns.resolve',
        'fetch',
        'http.get',
        'http.request',
        'https.get',
        'https.request',
        'net.connect',
        'net.createConnection',
        'tls.connect',
      ],
      `the preload installed a different set of patches than this test expects: ${installed.join(', ')}`,
    );
    // Written as "every line says SHUT" rather than "no line says OPEN": the first draft of this
    // probe used `require` in an ESM module, so every door threw a ReferenceError and a
    // check for the absence of OPEN would have passed on eight broken calls.
    assert.deepEqual(
      lines.filter((l) => !l.startsWith('SHUT ')),
      [],
      `a door was not shut, or did not fail the way this file expects: ${lines.join(' | ')}`,
    );
  });
});

/** The five the README names, with the arguments each one needs. */
const RULES_ONLY: Array<{ command: string; args: (dir: string) => string[] }> = [
  { command: 'sbom', args: (dir) => ['sbom', join(dir, 'app')] },
  { command: 'infra', args: (dir) => ['infra', join(dir, 'app')] },
  { command: 'portfolio', args: (dir) => ['portfolio', dir] },
  { command: 'audit', args: () => ['audit'] },
  { command: 'safety', args: () => ['safety'] },
];

describe('the five commands the README calls rules-only', () => {
  for (const { command, args } of RULES_ONLY) {
    it(`${command} sends nothing off the machine and calls no model`, () => {
      const dir = project();
      const { out, code } = run(args(dir), dir);
      assert.ok(!out.includes(REACHED_OUT), `${command} tried to reach the network:${NL}${out.slice(0, 2000)}`);
      assert.ok(code === 0, `${command} exited ${code} with the network shut, so the claim does not hold as written:${NL}${out.slice(0, 2000)}`);
      assert.ok(out.trim().length > 0, `${command} produced nothing, so this test proved nothing`);
    });
  }

  it('names exactly the commands the README claims it for', () => {
    // If the README's list grows, this test has to grow with it, or the new command ships with the
    // claim and nothing behind it. The list is read out of the README rather than kept in step by
    // hand, for the reason every other guard in this project exists.
    const text = lf(readFileSync(join(ROOT, 'README.md'), 'utf8'));
    // Anchored on what the block contains, not on how far it sits from the sentence above it.
    // The first version allowed 400 characters between the two, and adding a paragraph about this
    // very test to the README pushed the block out of range - the guard broke on the commit that
    // documented it. A distance is a fact about today's layout; a `tewip sbom` line is the block.
    const names = RULES_ONLY.map((r) => r.command);
    const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    // The block that lists all five, not merely one of them: `tewip sbom` alone appears in a second
    // block further up as an example invocation, so a single-command anchor matched two places.
    const block = blocks.filter((b) => names.every((n) => new RegExp(`^tewip ${n}\\b`, 'm').test(b)));
    assert.equal(
      block.length,
      1,
      `expected exactly one bash block listing all of ${names.join(', ')}, found ${block.length}. ` +
        'If a command has left that block it has also left the claim, and this test stops covering it.',
    );
    const listed = [...block[0].matchAll(/^tewip (\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(
      listed,
      [...names].sort(),
      'the README claims rules-only for a different set of commands than this test checks',
    );
  });
});
