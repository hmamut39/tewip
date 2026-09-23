// Which occurrence of a colliding value may be made unique. This exists because measuring the
// test-data fix against real commits turned up a case where the "value" was an assertion message,
// and the fix rewrote it: a test that then passes for the wrong reason, which is worse than the
// flake it was meant to fix.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseDataSite } from '../autofix/data-site.ts';
import { findLiteral } from '../autofix/data.ts';

const NL = String.fromCharCode(10);
const file = (...lines: string[]) => lines.join(NL);
const choose = (source: string, value: string) => chooseDataSite(source, findLiteral(source, value), value);

describe('choosing where to make a value unique', () => {
  it('takes the one place it is written', () => {
    const source = file("test('signs up', async () => {", "  await signUp('sam@example.com');", '});');
    const choice = choose(source, 'sam@example.com');
    assert.ok(choice.site, 'one occurrence, and it creates a record');
    assert.equal(choice.site.line, 2);
  });

  it('refuses when the only place is something the test checks', () => {
    // Rewriting this would change what the test asserts and leave the collision in place.
    const source = file("test('shows the user', async ({ page }) => {", "  await expect(page.getByText('admin')).toBeVisible();", '});');
    const choice = choose(source, 'admin');
    assert.equal(choice.site, null);
    assert.equal(choice.site === null ? choice.reason : '', 'value-only-asserted');
    assert.match(choice.site === null ? choice.why : '', /checking it rather than creating it/);
  });

  it('picks the line that creates the record, not the line that checks it', () => {
    const source = file(
      "test('creates a user', async ({ page }) => {",
      "  const email = 'sam@example.com';",
      '  await createUser(email);',
      "  await expect(page.getByText('sam@example.com')).toBeVisible();",
      '});',
    );
    const choice = choose(source, 'sam@example.com');
    assert.ok(choice.site);
    assert.equal(choice.site.line, 2, 'the assignment, not the assertion');
  });

  it('refuses when several places create with the same value, since they belong together', () => {
    const source = file(
      "test('two accounts', async () => {",
      "  const owner = await createUser('shared@example.com');",
      "  const member = await createMember('shared@example.com');",
      '});',
    );
    const choice = choose(source, 'shared@example.com');
    assert.equal(choice.site, null);
    assert.equal(choice.site === null ? choice.reason : '', 'value-ambiguous');
    assert.match(choice.site === null ? choice.why : '', /break the link between them/);
  });

  it('refuses when it cannot tell which occurrence is the data', () => {
    const source = file(
      "test('checks a label', async ({ page }) => {",
      "  await page.getByRole('button', { name: 'Submit' }).click();",
      "  await expect(page.getByText('Submit')).toBeVisible();",
      '});',
    );
    const choice = choose(source, 'Submit');
    assert.equal(choice.site, null);
    assert.equal(choice.site === null ? choice.reason : '', 'value-only-asserted');
  });
});
