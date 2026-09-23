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
    assert.match(choice.site === null ? choice.why : '', /checking it rather than creating anything/);
  });

  it('picks the creating line when nothing checks the value', () => {
    const source = file("test('creates a user', async () => {", "  const email = 'sam@example.com';", '  await createUser(email);', '  expect(response.status).toBe(201);', '});');
    const choice = choose(source, 'sam@example.com');
    assert.ok(choice.site);
    assert.equal(choice.site.line, 2, 'the assignment');
  });

  it('refuses when the value is both created and checked, since both must change together', () => {
    // The commonest shape in the real commits: `name: "Secondi"` and then
    // `expect(body.data.name).toBe("Secondi")`. Making only the data unique leaves the assertion
    // looking for the old value, turning a flaky test into a failing one.
    const source = file("test('creates a category', async () => {", '  const body = await post({', '    name: "Secondi",', '  });', '  expect(body.data.name).toBe("Secondi");', '});');
    const choice = choose(source, 'Secondi');
    assert.equal(choice.site, null);
    assert.equal(choice.site === null ? choice.reason : '', 'value-also-asserted');
    assert.match(choice.site === null ? choice.why : '', /have to change together/);
  });

  it('never rewrites a value that names an element rather than data', () => {
    const source = file("test('clicks submit', async ({ page }) => {", "  await page.getByRole('button', { name: 'Submit' }).click();", '});');
    const choice = choose(source, 'Submit');
    assert.equal(choice.site, null, 'rewriting a locator would point the test at an element that does not exist');
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

  it('refuses when every occurrence is a locator or an assertion', () => {
    const source = file("test('checks a label', async ({ page }) => {", "  await page.getByRole('button', { name: 'Submit' }).click();", "  await expect(page.getByText('Submit')).toBeVisible();", '});');
    const choice = choose(source, 'Submit');
    assert.equal(choice.site, null);
    assert.equal(choice.site === null ? choice.reason : '', 'value-only-asserted');
  });
});
