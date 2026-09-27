// Phase 22. What these tests protect is not the catching - that is the easy half - but the refusing.
//
// A tool that tells a developer their test is worthless when it is not gets ignored, and after that
// it does not matter how many real ones it finds. So the cases below are mostly legitimate tests in
// shapes that a naive check would flag: a helper that does the asserting, a Cypress `.should`, a
// `assert.equal`, a catch block that fails the test properly, a tautology sitting beside real checks.
// Each of those must come back clean or undecided, never condemned.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { vouchFile, type Verdict } from '../vouch/vouch.ts';

const verdictOf = (file: string, text: string): Verdict => {
  const vouched = vouchFile(file, text);
  assert.equal(vouched.unread, '', `nothing was judged in ${file}: ${vouched.unread}`);
  assert.equal(vouched.judgements.length, 1, 'these fixtures hold exactly one test');
  return vouched.judgements[0].verdict;
};

describe('a test that cannot fail', () => {
  it('names a test that compares no value, without calling it broken', () => {
    const verdict = verdictOf('cart.test.js', `it('adds to the cart', async () => {\n  const cart = new Cart();\n  cart.add(item);\n});`);
    assert.equal(verdict, 'crash-only');
  });

  it('catches an expectation nobody finished', () => {
    // The shape that survives review: it reads exactly like a check.
    assert.equal(verdictOf('cart.test.js', `it('has a total', () => {\n  const cart = build();\n  expect(cart.total);\n});`), 'unfinished-expectation');
  });

  it('catches a matcher that was named but never called', () => {
    assert.equal(verdictOf('cart.test.js', `it('is defined', () => {\n  expect(cart.total).toBeDefined;\n});`), 'unfinished-expectation');
  });

  it('catches a check whose subject is its own answer', () => {
    // The commonest placeholder in Node's own test style, and the vocabulary did not have it until a
    // realistic fixture for `tewip done` was written and quietly passed.
    assert.equal(verdictOf('refunds.test.js', `test('a refund is calculated', () => {
  refundFor({ total: 100 }, 10);
  assert.ok(true);
});`), 'tautology');
  });

  it('catches a check that compares something with itself', () => {
    assert.equal(verdictOf('cart.test.js', `it('works', () => {\n  expect(true).toBe(true);\n});`), 'tautology');
    assert.equal(verdictOf('test_cart.py', `def test_works():\n    total = compute()\n    assert True\n`), 'tautology');
  });

  it('catches a test that catches and discards its own failure', () => {
    const body = `it('logs in', async () => {\n  try {\n    await login();\n    expect(page.url()).toContain('/home');\n  } catch (error) {\n    console.log('login failed', error);\n  }\n});`;
    assert.equal(verdictOf('login.test.js', body), 'swallows-failure');
  });

  it('does not condemn a callback test: it fails when done is never called', () => {
    // express has dozens of these. Mocha fails the test by timeout if `done` never arrives, so the
    // callback is the check even though nothing is asserted.
    const text = `it('should inherit from event emitter', function(done){
  var app = express();
  app.on('foo', done);
  app.emit('foo');
})`;
    const vouched = vouchFile('app.test.js', text);
    assert.equal(vouched.judgements[0].verdict, 'checks');
    assert.match(vouched.judgements[0].why, /fails if done\(\) is never called/);
  });

  it('catches a skipped test, in each language it reads', () => {
    assert.equal(verdictOf('cart.test.js', `it.skip('adds to the cart', () => {\n  expect(cart.total).toBe(2);\n});`), 'never-runs');
    assert.equal(verdictOf('test_cart.py', `@pytest.mark.skip(reason="flaky")\ndef test_total():\n    assert total() == 2\n`), 'never-runs');
    assert.equal(verdictOf('CartTest.java', `@Test\n@Disabled\nvoid totalsTheOrder() {\n  assertEquals(2, cart.total());\n}`), 'never-runs');
  });

  it('says a focused test stops the rest of the file from running', () => {
    const vouched = vouchFile('cart.test.js', `it.only('one', () => { expect(1).toBe(2); });\nit('two', () => { expect(a).toBe(b); });`);
    assert.match(vouched.focused, /does not run/);
  });
});

describe('what it must not accuse', () => {
  it('clears a test whose checking happens in a helper defined beside it', () => {
    const text = `function expectTotals(cart, value) {\n  expect(cart.total).toBe(value);\n}\n\nit('totals the order', () => {\n  const cart = build();\n  expectTotals(cart, 2);\n});`;
    const vouched = vouchFile('cart.test.js', text);
    const last = vouched.judgements.at(-1);
    assert.equal(last?.verdict, 'checks');
    assert.match(last?.why ?? '', /through expectTotals\(\)/);
  });

  it('refuses to judge a test whose helper is imported from somewhere else', () => {
    const text = `import { verifyTotals } from './helpers.js';\n\nit('totals the order', () => {\n  const cart = build();\n  verifyTotals(cart, 2);\n});`;
    const vouched = vouchFile('cart.test.js', text);
    assert.equal(vouched.judgements[0].verdict, 'cannot-tell');
    assert.match(vouched.judgements[0].why, /not in this file/);
  });

  it('knows the assertion styles that are not expect()', () => {
    // Each of these was a real wrong refusal in Phase 8 before the vocabulary was widened.
    const clean: Array<[string, string]> = [
      ['cart.cy.js', `it('shows the total', () => {\n  cy.get('[data-test=total]').should('have.text', '2');\n});`],
      ['cart.test.js', `it('totals', () => {\n  assert.equal(cart.total, 2);\n});`],
      ['test_cart.py', `def test_total():\n    assert cart.total() == 2\n`],
      ['test_cart.py', `def test_raises():\n    with pytest.raises(ValueError):\n        cart.add(None)\n`],
      ['CartTest.java', `@Test\nvoid totals() {\n  assertThat(cart.total()).isEqualTo(2);\n}`],
      ['cart_test.go', `func TestTotal(t *testing.T) {\n  if cart.Total() != 2 {\n    t.Errorf("wrong total")\n  }\n}`],
      ['CartTests.cs', `[Fact]\npublic void Totals() {\n  Assert.Equal(2, cart.Total());\n}`],
      ['cart.spec.ts', `it('is visible', async () => {\n  await expect(page.getByRole('button')).toBeVisible();\n});`],
    ];
    for (const [file, text] of clean) {
      assert.equal(verdictOf(file, text), 'checks', `${file} really does check something`);
    }
  });

  it('leaves a catch block alone when it fails the test properly', () => {
    const rethrows = `it('logs in', async () => {\n  try {\n    await login();\n    expect(page.url()).toContain('/home');\n  } catch (error) {\n    throw new Error('login broke: ' + error.message);\n  }\n});`;
    assert.equal(verdictOf('login.test.js', rethrows), 'checks');
    const asserts = `def test_login():\n    try:\n        login()\n    except Exception as error:\n        pytest.fail(str(error))\n    assert session.active\n`;
    assert.equal(verdictOf('test_login.py', asserts), 'checks');
  });

  it('does not condemn a tautology that sits beside a real check', () => {
    const text = `it('totals the order', () => {\n  expect(true).toBe(true);\n  expect(cart.total).toBe(2);\n});`;
    assert.equal(verdictOf('cart.test.js', text), 'checks', 'untidy is not the same as worthless');
  });

  it('says nothing about a file it cannot read into, rather than clearing it', () => {
    const vouched = vouchFile('cart.test.rb', `describe Cart do\n  it 'totals' do\n    expect(cart.total).to eq 2\n  end\nend`);
    assert.deepEqual(vouched.judgements, []);
    assert.match(vouched.unread, /does not read this kind of file/);
  });

  it('will not vouch for source code, which is a different question', () => {
    const vouched = vouchFile('src/cart.js', `export function total(items) {\n  return items.reduce((a, b) => a + b.price, 0);\n}`);
    assert.match(vouched.unread, /does not look like a test file/);
  });

  it('does not clear a test file whose shape it failed to recognise', () => {
    const vouched = vouchFile('cart.test.js', `describe('cart', () => {\n  // everything here was deleted\n});`);
    assert.deepEqual(vouched.judgements, []);
    assert.match(vouched.unread, /rather than clearing it/);
  });

  it('does not read a quoted check as the test own check', () => {
    // A test *about* tautologies quotes one. Before strings were blanked in the verdicts - not only in
    // the extractor - Tewip accused its own suite of comparing a value with itself, and the eight-project
    // precision run could not see it, because ordinary projects do not quote test code inside tests.
    const text = ['it("catches a tautology", () => {', '  assert.equal(judge("expect(true).toBe(true);"), "tautology");', '});'].join(String.fromCharCode(10));
    assert.equal(verdictOf('vouch.test.js', text), 'checks');
  });

  it('does not read a quoted expectation as an unfinished one', () => {
    const text = ['it("catches an unfinished expectation", () => {', '  assert.equal(judge("expect(cart.total);"), "unfinished");', '});'].join(String.fromCharCode(10));
    assert.equal(verdictOf('vouch.test.js', text), 'checks');
  });

  it('is not fooled by a brace inside a string or a comment', () => {
    const text = `it('handles json', () => {\n  const raw = '{"a": 1}';\n  // } not the end\n  expect(JSON.parse(raw).a).toBe(1);\n});`;
    assert.equal(verdictOf('json.test.js', text), 'checks');
  });

  it('does not read test code that lives inside a string', () => {
    // Found by pointing this at Tewip's own suite: fixtures quote fake tests, and judging them
    // produced 27 confident false accusations in one run.
    const text = [
      "const SOURCE = [",
      "  \"test('starts checkout', async ({ page }) => {\",",
      "  \"  await page.click('#go');\",",
      "  '});',",
      "].join('.');",
      "",
      "it('rewrites the wait', () => {",
      "  expect(fix(SOURCE)).toContain('toBeVisible');",
      "});",
    ].join(String.fromCharCode(10));
    const vouched = vouchFile('autofix.test.ts', text);
    assert.equal(vouched.judgements.length, 1, 'the fixture inside the string is not a test');
    assert.equal(vouched.judgements[0].verdict, 'checks');
  });

  it('knows AVA and tap put their assertions on the test context', () => {
    // 59 of 59 tests in chalk were condemned before this: the third repeat of the same lesson.
    assert.equal(verdictOf('chalk.js', `test('supports multiple arguments', t => {
  t.is(chalk('hello', 'there'), 'hello there');
});`), 'checks');
    assert.equal(verdictOf('tap.test.js', `test('parses', t => {
  t.same(parse('a'), ['a']);
});`), 'checks');
  });

  it('does not judge a Go benchmark as a test that forgot to assert', () => {
    const text = `func BenchmarkRouteSimple(b *testing.B) {
  router := new(Router)
  router.Handle("/", nil)
}`;
    assert.deepEqual(vouchFile('bench_test.go', text).judgements, [], 'a benchmark asserts nothing by design');
  });

  it('does not treat a nested def as a test', () => {
    // In Click's own suite, `def test(count)` inside a real test is a CLI command being defined.
    const text = `def test_other_command_forward(runner):
    cli = click.Group()

    @cli.command()
    def test(count):
        click.echo(count)

    result = runner.invoke(cli, ["dist"])
    assert not result.exception
`;
    const vouched = vouchFile('test_commands.py', text);
    assert.equal(vouched.judgements.length, 1);
    assert.equal(vouched.judgements[0].verdict, 'checks');
  });

  it('knows a conditional skip still runs somewhere', () => {
    const python = `@pytest.mark.skipif(sys.platform != "win32", reason="windows only")
def test_registry():
    assert bypass_proxies("localhost")
`;
    assert.equal(verdictOf('test_utils.py', python), 'checks', 'skipif runs on the platform it is for');
    const go = `func TestDeadcodeElimination(t *testing.T) {
  if runtime.GOOS == "windows" {
    t.Skip("go tool nm fails on windows")
  }
  if size > limit {
    t.Errorf("too big")
  }
}`;
    assert.equal(verdictOf('cobra_test.go', go), 'checks', 'a skip inside an if is conditional');
  });

  it('reads a def whose parameters run over several lines', () => {
    // The parameter list was being read as the body, and the real body thrown away, so tests in
    // psf/requests came back as comparing no value when they assert plenty.
    const text = `def test_proxy_authorization(
    self, url, has_proxy_auth
):
    session = requests.Session()
    assert has_proxy_auth == ("Proxy-Authorization" in session.headers)
`;
    assert.equal(verdictOf('test_requests.py', text), 'checks');
  });

  it('reads a Java method name through its throws clause', () => {
    const text = `@Test
public void testPeekLargerThanLongMaxValue() throws IOException {
  assertThat(reader.peek()).isEqualTo(NUMBER);
}`;
    assert.equal(vouchFile('JsonReaderTest.java', text).judgements[0].name, 'testPeekLargerThanLongMaxValue');
  });

  it('reads a commented-out check as no check at all', () => {
    const text = `it('totals the order', () => {\n  const cart = build();\n  // expect(cart.total).toBe(2);\n});`;
    assert.equal(verdictOf('cart.test.js', text), 'crash-only', 'a check somebody commented out is the classic way a test stops checking');
  });
});
