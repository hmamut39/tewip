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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MEASURED } from '../evidence/confidence.ts';
import { lf } from '../lines.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const README = lf(readFileSync(join(ROOT, 'README.md'), 'utf8'));

/** The top-level directories of this repository, so a reference can be told from a filename. */
const TOP = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name);

describe('every file the README points at', () => {
  it('exists', () => {
    // Only references that look like a path into this repository. The README also names files the
    // reader creates - `infra.md` and `quality.md` are `--out` arguments - and bare basenames like
    // `evaluate.ts`, and asserting those exist would be asserting something false about the
    // reader's machine. The first version of this check reported 14 of 49 references as missing,
    // every one of them a file nobody claimed was here.
    const refs = [...README.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|js|md|json|yml|yaml|jsonl|sql))`/g)]
      .map((m) => m[1])
      .filter((p) => p.includes('/') && TOP.includes(p.split('/')[0]));
    assert.ok(refs.length > 10, `only ${refs.length} repo paths found in the README, so this test is not reading it properly`);
    const missing = [...new Set(refs)].filter((p) => !existsSync(join(ROOT, p)));
    assert.deepEqual(missing, [], `the README points at files that are not there: ${missing.join(', ')}`);
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
    const words: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
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
