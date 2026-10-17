// Phase 27: the house rules a team writes down.
//
// The feature is easy; the honesty is the hard part, and it is what these tests hold. A standard has two
// halves - rules a pattern can check, and prose it cannot - and Tewip must never let the second look like
// the first. A team that believes an unenforceable rule is being enforced is worse off than a team with
// no tool at all, because they have stopped watching for it themselves.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check, covers, readStandard, renderViolations } from '../standards/standards.ts';
import { renderStandards } from '../standards/standards-command.ts';

const NL = String.fromCharCode(10);
const file = (...lines: string[]) => lines.join(NL);

const noWaits = file(
  '---',
  'description: A fixed wait hides a race instead of fixing it.',
  'applies-to: tests/, e2e/',
  'forbid: /waitForTimeout|sleep\\(/ because a fixed wait passes by luck and fails in CI',
  '---',
  '',
  'Wait for the thing you are actually waiting for, never for a number of milliseconds.',
);

describe('reading a standard a team wrote', () => {
  it('reads the rule, its scope and the reason, and keeps the prose as guidance', () => {
    const standard = readStandard('no-fixed-waits.md', noWaits);
    assert.equal(standard.name, 'no-fixed-waits');
    assert.equal(standard.description, 'A fixed wait hides a race instead of fixing it.');
    assert.deepEqual(standard.appliesTo, ['tests/', 'e2e/']);
    assert.equal(standard.rules.length, 1);
    assert.equal(standard.rules[0].kind, 'forbid');
    assert.match(standard.rules[0].because, /passes by luck/);
    assert.match(standard.guidance, /never for a number of milliseconds/);
  });

  it('accepts a standard that is only prose, and gives it no rules', () => {
    // Most of what a team knows cannot be written as a pattern. That is allowed, and it must not look
    // like something Tewip is enforcing.
    const standard = readStandard('migrations.md', '# Releasing schema changes\n\nWe never drop a column in the release that stops writing to it.');
    assert.deepEqual(standard.rules, []);
    assert.match(standard.guidance, /never drop a column/);
    assert.equal(standard.description, 'Releasing schema changes');
  });

  it('says a rule is unusable rather than ignoring it', () => {
    // A rule nobody is enforcing is worse than no rule, because somebody believes in it.
    const standard = readStandard('broken.md', file('---', 'forbid: waitForTimeout', '---', '', 'prose'));
    assert.deepEqual(standard.rules, []);
    assert.match(standard.unusable, /could not be read/);
  });

  it('refuses a pattern that is not a valid expression', () => {
    const standard = readStandard('bad.md', file('---', 'forbid: /unclosed(/ because reasons', '---'));
    assert.deepEqual(standard.rules, []);
    assert.ok(standard.unusable);
  });

  it('takes a rule with its own scope, overriding the standard\'s', () => {
    const standard = readStandard('mixed.md', file('---', 'applies-to: src/', 'forbid: /console\\.log/ in tests/ because logs hide assertions', '---'));
    assert.deepEqual(standard.rules[0].where, ['tests/']);
  });
});

describe('checking a file against the rules', () => {
  const standards = [readStandard('no-fixed-waits.md', noWaits)];

  it('quotes the line that breaks a forbid rule', () => {
    const broken = check(standards, 'tests/checkout.spec.ts', file('test("x", async () => {', '  await page.waitForTimeout(2000);', '});'));
    assert.equal(broken.length, 1);
    assert.equal(broken[0].line, 2);
    assert.match(broken[0].text, /waitForTimeout\(2000\)/);
  });

  it('leaves a file outside the scope alone', () => {
    const broken = check(standards, 'src/server.ts', 'await sleep(100);');
    assert.deepEqual(broken, [], 'the standard applies to tests, and this is not one');
  });

  it('reports a require rule against the file rather than inventing a line', () => {
    const standards = [readStandard('locators.md', file('---', 'applies-to: tests/', 'require: /data-testid/ because every element we assert on carries one', '---'))];
    const broken = check(standards, 'tests/legacy.spec.ts', 'expect(page.locator("h1")).toBeVisible();');
    assert.equal(broken.length, 1);
    assert.equal(broken[0].line, 0, 'nothing is missing on a particular line, so none is claimed');
    assert.deepEqual(check(standards, 'tests/ok.spec.ts', 'page.locator("[data-testid=total]")'), []);
  });

  it('matches a scope by path fragment or extension', () => {
    assert.equal(covers(['tests/'], 'tests/checkout.spec.ts'), true);
    assert.equal(covers(['**/*.sql'], 'migrations/0001.sql'), true);
    assert.equal(covers(['tests/'], 'src/app.ts'), false);
    assert.equal(covers([], 'anything.ts'), true);
  });
});

describe('what the report may claim', () => {
  it('says nothing when nothing is broken', () => {
    assert.deepEqual(renderViolations([], [readStandard('a.md', noWaits)]), []);
  });

  it('never counts guidance as kept or broken', () => {
    const standards = [readStandard('no-fixed-waits.md', noWaits), readStandard('migrations.md', 'We never drop a column in the release that stops writing to it.')];
    const broken = check(standards, 'tests/x.spec.ts', 'await page.waitForTimeout(1);');
    const report = renderViolations(broken, standards).join(NL);
    assert.match(report, /Your own standards \(1\)/);
    assert.match(report, /cannot check/);
    assert.match(report, /not counted here as either kept or broken/);
  });

  it('prints the team\'s own reason beside the violation', () => {
    const report = renderViolations(check([readStandard('a.md', noWaits)], 'tests/x.spec.ts', 'await sleep(1);'), []).join(NL);
    assert.match(report, /passes by luck and fails in CI/);
  });
});

// Phase 67: field-tested by writing this project's own house rules in `.tewip/standards/` - four
// checkable rules plus three paragraphs of prose - and running the command on real changes. Three
// findings, and one of them was found by accident while fixing another.
describe('a standard with both rules and prose', () => {
  const both = file(
    '---',
    'name: suite integrity',
    'description: Rules that keep the suite able to fail.',
    'forbid: /\\bit\\.only\\(/ in test because a .only turns the whole suite into one test',
    '---',
    '',
    'Every source file stays under 300 lines. Test files are exempt.',
  );

  it('is read as a standard with a rule and with guidance', () => {
    const standard = readStandard('suite-integrity.md', both);
    assert.equal(standard.rules.length, 1);
    assert.ok(standard.guidance.includes('under 300 lines'));
  });

  it('survives the byte-order mark Windows editors write', () => {
    // Three invisible bytes before `---` stopped the front matter matching, so every enforced rule
    // in the file silently became prose and the report said "0 with rules Tewip can check" without
    // once mentioning why. Found by accident: this project's own standards file was rewritten by a
    // PowerShell command and four working rules stopped being enforced, with no error anywhere.
    const withBom = readStandard('suite-integrity.md', '\uFEFF' + both);
    assert.equal(withBom.rules.length, 1, 'a BOM must not turn an enforced rule into prose');
    assert.equal(withBom.name, 'suite integrity', 'and the front matter is still read');
  });

  it('says in the report that the guidance exists, not only when a standard has nothing else', () => {
    // `guidanceOnly` required `rules.length === 0`, so a standard written in the documented shape -
    // rules then prose - had its prose invisible, under a closing line promising that everything
    // else is prose Tewip carries for you.
    const report = renderStandards([readStandard('suite-integrity.md', both)], [], 0);
    assert.match(report, /Carried, but not checked/);
    assert.match(report, /suite integrity/);
    assert.match(report, /word\(s\) of guidance \(alongside its 1 enforced rule\)/);
  });
});

describe('a rule with an exception', () => {
  const noPrinting = file(
    '---',
    'name: no printing from the engine',
    'forbid: /console\\.log\\(/ in engine/ not -command.ts because the command layer is what prints',
    '---',
  );

  it('applies where it says and not where it says not', () => {
    const [standard] = [readStandard('no-printing.md', noPrinting)];
    assert.equal(standard.rules.length, 1);
    assert.deepEqual(standard.rules[0].where, ['engine/']);
    assert.deepEqual(standard.rules[0].except, ['-command.ts']);
    assert.equal(check([standard], 'engine/flaky/flaky.ts', 'console.log(x);').length, 1, 'engine code may not print');
    assert.equal(check([standard], 'engine/flaky/flaky-command.ts', 'console.log(x);').length, 0, 'the command layer may');
  });

  it('still checks every rule that has no exception at all', () => {
    // `|| covers(rule.except, file)` reads correctly and is wrong: covers([]) is true, because an
    // empty scope means everything - so every rule without an exception was skipped and the report
    // said nothing broke. A clean answer produced by a bug.
    const plain = readStandard('plain.md', file('---', 'forbid: /TODO/ because a TODO is not a plan', '---'));
    assert.deepEqual(plain.rules[0].except, []);
    assert.equal(check([plain], 'anything.ts', 'const x = 1; // TODO').length, 1);
  });
});
