// Phase 27: the house rules a team writes down.
//
// The feature is easy; the honesty is the hard part, and it is what these tests hold. A standard has two
// halves - rules a pattern can check, and prose it cannot - and Tewip must never let the second look like
// the first. A team that believes an unenforceable rule is being enforced is worse off than a team with
// no tool at all, because they have stopped watching for it themselves.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check, covers, readStandard, renderViolations } from '../standards/standards.ts';

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
