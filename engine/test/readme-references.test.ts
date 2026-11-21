// Everything the README points at, checked against what is actually there.
//
// The README is the front door. Somebody deciding whether to put this in front of an IT department
// reads it before they read anything else, and a reference in it that goes nowhere costs more than
// the same mistake would anywhere in the source.
//
// Three categories here, all of them cheap to re-derive and none of them previously guarded. All
// three were clean when this file was written, which is worth saying plainly: this is not a fix, it
// is the difference between "clean" and "clean, and something checks". Every count claim in this
// document was true when it was written too - "fifteen tools" against 25 served, "two commands"
// against 23, "seven checks" against eight - and each stayed wrong for weeks because nothing
// re-derived it.
//
// Not covered, and stated rather than implied: external URLs, which need the network and so belong
// in a scheduled workflow rather than the unit suite; and the prose claims, which are the bulk of
// the document and have to be taken one at a time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { measure as wordings } from '../../eval/driver-wordings.ts';
import { MEASURED } from '../evidence/confidence.ts';
import { lf } from '../lines.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const README = lf(readFileSync(join(ROOT, 'README.md'), 'utf8'));

/** The top-level directories of this repository, so a reference can be told from a filename. */
const TOP = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name);

/**
 * Files the README names that git does not track, because Tewip writes them when it runs.
 *
 * Named one by one rather than matched by directory. The first version of the test below asked
 * `existsSync` instead, which passed on the machine it was written on and failed on all three CI
 * platforms at once: these three exist here only because this project has been run here, and a
 * fresh checkout has none of them. A guard that depends on the author's working directory is the
 * exact thing the three-platform matrix was added to catch, and it caught this one on the commit
 * that introduced it.
 */
const WRITTEN_AT_RUNTIME = ['data/triage.jsonl', 'data/runs.jsonl', 'data/llm-cache.jsonl'];

describe('every file the README points at', () => {
  it('is tracked in this repository, or is one Tewip writes', () => {
    // Only references that look like a path into this repository. The README also names files the
    // reader creates - `infra.md` and `quality.md` are `--out` arguments - and bare basenames like
    // `evaluate.ts`, and asserting those exist would be asserting something false about the
    // reader's machine. The first version of this check reported 14 of 49 references as missing,
    // every one of them a file nobody claimed was here.
    const refs = [...README.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|js|md|json|yml|yaml|jsonl|sql))`/g)]
      .map((m) => m[1])
      .filter((p) => p.includes('/') && TOP.includes(p.split('/')[0]));
    assert.ok(refs.length > 10, `only ${refs.length} repo paths found in the README, so this test is not reading it properly`);

    // Git's own list, not the filesystem. A tracked file that was renamed stops being in it, which
    // is the case worth catching; a file that exists only because something ran here never was.
    const tracked = new Set(
      spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
        .stdout.split(String.fromCharCode(10))
        .map((l) => l.trim())
        .filter(Boolean),
    );
    assert.ok(tracked.size > 100, `git listed ${tracked.size} tracked files, so this test cannot check anything`);

    const missing = [...new Set(refs)].filter((p) => !tracked.has(p) && !WRITTEN_AT_RUNTIME.includes(p));
    assert.deepEqual(
      missing,
      [],
      `the README points at files this repository does not contain: ${missing.join(', ')}. ` +
        'If one is written when Tewip runs, add it to WRITTEN_AT_RUNTIME and say so there.',
    );

    // The allowlist has to stay honest in the other direction too: an entry that becomes tracked,
    // or stops being mentioned, is an entry nobody needs any more.
    const stale = WRITTEN_AT_RUNTIME.filter((p) => tracked.has(p) || !README.includes(p));
    assert.deepEqual(stale, [], `these are allowlisted as runtime files and no longer need to be: ${stale.join(', ')}`);
  });
});

describe('every command the README shows', () => {
  it('is a verb the command line actually dispatches', () => {
    // Derived the way engine/test/cli-help.test.ts derives it - from every `case 'verb':` across
    // tewip.ts and each cli/verbs-*.ts - because naming the files by hand is how that test once
    // missed verbs-prove.ts entirely and covered two thirds of what it claimed to.
    const dir = join(ROOT, 'cli');
    const sources = ['tewip.ts', ...readdirSync(dir).filter((f) => /^verbs-.*\.ts$/.test(f))];
    const dispatched = new Set(
      [...sources.map((f) => readFileSync(join(dir, f), 'utf8')).join('').matchAll(/case '([a-z0-9-]+)':/g)].map((m) => m[1]),
    );
    assert.ok(dispatched.size > 20, `only ${dispatched.size} verbs found, so this test is not reading the dispatcher properly`);

    const shown = new Set([...README.matchAll(/\btewip ([a-z][a-z-]+)\b/g)].map((m) => m[1]));
    assert.ok(shown.size > 20, `only ${shown.size} commands found in the README, so this test is not reading it properly`);

    // `mcp` is dispatched outside the switch, and `help` is handled before it.
    const invented = [...shown].filter((v) => !dispatched.has(v) && !['mcp', 'help'].includes(v)).sort();
    assert.deepEqual(invented, [], `the README shows commands that do not exist: ${invented.join(', ')}`);
  });
});

describe('every link inside the README', () => {
  it('points at a heading that is in it', () => {
    // A broken anchor does not error; it scrolls nowhere, and the reader concludes the section
    // they were promised is not there.
    const slugs = new Set(
      [...README.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
        m[1]
          .trim()
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-'),
      ),
    );
    const links = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    const broken = links.filter((l) => !slugs.has(l));
    assert.deepEqual(broken, [], `these links point at headings the README does not have: ${broken.map((b) => `#${b}`).join(', ')}`);
  });
});

// Phase 172: the opening paragraph said every number in the table was measured on strangers' real
// code, "never on fixtures". That is true of the precision column and of `vouch`, and false of
// every other recall figure in it - all eight are measured on controls planted twice, once in the
// shape a published standard warns against and once in the shape it recommends, because recall
// needs the complete list of what is in the file and nobody can know that for a stranger's
// repository.
//
// The worst possible place to overclaim is the sentence about not overclaiming. These two
// assertions hold the replacement to the thing it describes.
describe("the README's account of how its numbers were measured", () => {
  it('does not claim every number came from real code rather than fixtures', () => {
    assert.doesNotMatch(
      README,
      /Each number below was measured on strangers' real code, never on fixtures/,
      'that sentence is false for the recall column: eight of the ten rows are measured on planted controls',
    );
  });

  it('says how many rows count decoys rather than real projects, and is right', () => {
    // `pinnedIn` is how a row declares that its precision was measured on named real repositories.
    // A row without one counts its own planted decoys, which is legitimate and different, and the
    // README now states the number - so it needs re-deriving like every other count in it.
    const decoyOnly = MEASURED.filter((r) => !r.pinnedIn).length;
    const words: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
    const claimed = words[decoyOnly];
    assert.ok(claimed, `no word for ${decoyOnly} rows; add it or rewrite the sentence as a numeral`);
    assert.match(
      README,
      new RegExp(`except for ${claimed} rows that count planted decoys`),
      `${decoyOnly} rows in confidence.ts count decoys rather than real projects, and the README's opening does not say so`,
    );
  });
});

// Phase 172: the stack sentence named Kotlin and TestNG, and CI exercises neither.
//
// It said "It works for every stack: ... Java and Kotlin (JUnit, TestNG) ... each checked against
// its real runner's report". Kotlin appears nowhere in this repository - no fixture, no workflow,
// no line of code - and a native TestNG report is explicitly refused: `importJunit` throws, names
// the six formats it does read, and tells the reader to point it at the Surefire report. That
// refusal is the product behaving exactly as it should. The sentence was the defect.
//
// This holds the runners the sentence names to the ones the polyglot workflow actually runs, so
// the next runner added to the list has to be added to CI as well - or the sentence has to say it
// is not checked, which is what it now does for Kotlin.
describe("the README's list of test runners", () => {
  const workflow = lf(readFileSync(join(ROOT, '.github', 'workflows', 'polyglot-fixtures.yml'), 'utf8'));

  it('names only runners that CI runs for real', () => {
    // Each runner as the README writes it, and the string that proves CI runs it. Kept as pairs
    // rather than matched loosely: "JUnit" appears in the .NET job's output format too, and a
    // substring search would have called the Java claim covered by the wrong job.
    const runners: Array<[string, RegExp]> = [
      ['node:test', /node --test|node:test/],
      ['Jest', /jest/i],
      ['Vitest', /vitest/i],
      ['Mocha', /mocha/i],
      ['pytest', /pytest/i],
      ['Maven Surefire', /surefire/i],
      ['gotestsum', /gotestsum/],
      ['dotnet test', /dotnet test/],
      ['RSpec', /rspec/i],
      ['PHPUnit', /phpunit/i],
      ['cargo nextest', /nextest/],
    ];
    const claimed = runners.filter(([name]) => README.includes(name));
    assert.equal(claimed.length, runners.length, `the README no longer names all of these runners: ${runners.filter(([n]) => !README.includes(n)).map(([n]) => n).join(', ')}`);
    const unrun = claimed.filter(([, inCi]) => !inCi.test(workflow)).map(([name]) => name);
    assert.deepEqual(unrun, [], `the README names these runners and the polyglot workflow does not run them: ${unrun.join(', ')}`);
  });

  it('does not claim Kotlin or a native TestNG report is checked', () => {
    // Either may be added - but then it has to be exercised, and this test rewritten deliberately
    // rather than a sentence quietly growing a stack nobody measured.
    // A plain string, not a regex. The first version built the pattern in a template literal, where
    // the backslashes escaping the brackets were eaten before the regex ever saw them - which is
    // the same class of mistake as the carriage returns this suite spent two phases on, and the
    // reason this file prefers an exact string wherever one will do.
    assert.ok(
      !README.includes('Java and Kotlin (JUnit, TestNG)'),
      'the README claims Kotlin and TestNG the way it used to, and CI exercises neither',
    );
    assert.match(README, /native TestNG/, 'the README should say plainly that a native TestNG report is not a format it reads');
    assert.match(README, /Kotlin is not among the runners CI exercises/, 'the README should say plainly that Kotlin is unexercised');
  });
});

// Phase 173: "checked against more than 500 real messages from public projects".
//
// That figure appears nowhere else in this repository - not in ROADMAP.md, not in eval/README.md,
// not in a data file. It was measured once during development and never written down, which makes
// it indistinguishable from a number somebody felt was about right.
//
// What is true, and measurable: the wordings are real, they are in driver-errors.test.ts with
// variants taken from public issue threads, and they run on every commit. What is also true, and
// was not said: none of these tools' wordings appears in the labelled failure data at all - the
// collected records are from Playwright projects, so a measured zero.
describe("the README's account of the browser and component-test tools", () => {
  const drivers = lf(readFileSync(join(ROOT, 'engine', 'test', 'driver-errors.test.ts'), 'utf8'));

  it('names only tools whose real wording is actually exercised', () => {
    const tools = ['Selenium', 'WebdriverIO', 'Cypress', 'Testing Library', 'Vue Test Utils', 'jest-dom', 'Jasmine'];
    const claimed = tools.filter((t) => README.includes(t));
    assert.equal(claimed.length, tools.length, `the README no longer names: ${tools.filter((t) => !README.includes(t)).join(', ')}`);
    const untested = claimed.filter((t) => !drivers.includes(t));
    assert.deepEqual(untested, [], `the README names these tools and driver-errors.test.ts does not cover them: ${untested.join(', ')}`);
  });

  it('is right that none of their wordings is in the labelled data', (t) => {
    // Re-derived, not asserted. The point of publishing a zero is that somebody can get it back,
    // and the harness also refuses to count jest-dom at all - Playwright's own expect API uses the
    // same matcher names, so a match there says nothing about which library printed it. The first
    // version of that harness counted 1,210 of them as jest-dom and would have published it.
    //
    // The collected data is gitignored - `data/*` in .gitignore, and nothing under `data/real` is
    // tracked - so this can only run where a harvest has happened. It skips with a reason rather
    // than failing, and rather than passing quietly: the first version asserted `records > 1000`
    // and would have gone red on every CI platform the moment it was pushed, which is what the
    // assertion above it had just done for the same reason.
    const counted = wordings();
    if (counted.datasets.length === 0) {
      t.skip('no labelled data on this machine (data/* is gitignored); run `node eval/driver-wordings.ts` where a harvest exists');
      return;
    }
    assert.ok(counted.records > 1000, `only ${counted.records} records read across ${counted.datasets.length} datasets, so this proves little`);
    const present = counted.tools.filter((tool) => !tool.ambiguous && tool.found > 0).map((tool) => `${tool.tool} (${tool.found})`);
    assert.deepEqual(present, [], `these wordings do appear in the labelled data, so the README's zero is wrong: ${present.join(', ')}`);
    assert.match(
      README,
      new RegExp(`zero across the ${counted.records.toLocaleString('en-US')} records`),
      `the README's record count has drifted from the ${counted.records} on disk`,
    );
  });

  it('no longer claims a figure nothing re-derives', () => {
    assert.ok(
      !README.includes('more than 500 real messages'),
      'that figure has no provenance anywhere in this repository; say where the wordings are instead',
    );
  });
});
