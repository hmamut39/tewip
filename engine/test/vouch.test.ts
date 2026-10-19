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
    // Elixir, which Tewip genuinely does not read. Ruby used to be the example here and is not
    // any more: Phase 36 taught it Ruby, PHP and Rust, and a test that pins a limitation has to
    // be retired the day the limitation is.
    const vouched = vouchFile('cart_test.exs', `defmodule CartTest do\n  test "totals" do\n    assert Cart.total() == 2\n  end\nend`);
    assert.deepEqual(vouched.judgements, []);
    assert.match(vouched.unread, /does not read this kind of file/);
  });

  it('reads Ruby now, in both of the shapes Ruby uses', () => {
    const rspec = vouchFile('cart_spec.rb', `describe Cart do\n  it 'totals' do\n    expect(cart.total).to eq 2\n  end\nend`);
    assert.equal(rspec.judgements.length, 1);
    assert.equal(rspec.judgements[0].verdict, 'checks');
    assert.equal(rspec.judgements[0].name, 'totals');

    const minitest = vouchFile('cart_test.rb', `class CartTest < Minitest::Test\n  def test_totals\n    assert_equal 2, cart.total\n  end\nend`);
    assert.equal(minitest.judgements.length, 1);
    assert.equal(minitest.judgements[0].verdict, 'checks', 'assert_equal has no parentheses and is still a check');
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

// Phase 36: Ruby, PHP and Rust, which triage had claimed for months while vouch refused to look.
//
// Every shape below is copied from a real suite - rails/activesupport (minitest), rspec-core's own
// specs, laravel/framework (PHPUnit) and ripgrep (Rust) - and each test here exists because the
// real file produced a wrong answer before it was written.
describe('Ruby, PHP and Rust', () => {
  const verdicts = (file: string, text: string) => vouchFile(file, text).judgements.map((j) => j.verdict);

  it("minitest's assert_equal counts, parentheses or not", () => {
    // 121 of the 154 real tests in Rails's string_ext_test.rb were reported as comparing no value,
    // because every generic `assert` pattern wanted a `.` or a `(` after the word.
    assert.deepEqual(verdicts('a_test.rb', `class T < Minitest::Test\n  def test_x\n    assert_equal "a", y\n  end\nend`), ['checks']);
    assert.deepEqual(verdicts('b_test.rb', `class T < Minitest::Test\n  def test_x\n    refute_nil y\n  end\nend`), ['checks']);
    assert.deepEqual(verdicts('c_test.rb', `class T < Minitest::Test\n  def test_x\n    assert y.valid?\n  end\nend`), ['checks']);
  });

  it("RSpec's block form is an assertion", () => {
    // `expect { ... }.to raise_error` is how every raise_error, change and output matcher is
    // written, and missing it reported rspec-core's own specs as unable to fail.
    const block = `describe X do\n  it 'raises' do\n    expect {\n      thing.run\n    }.to raise_error(ArgumentError)\n  end\nend`;
    assert.deepEqual(verdicts('x_spec.rb', block), ['checks']);
    const changing = `describe X do\n  it 'does not change' do\n    expect { thing.run }.not_to change { thing.count }\n  end\nend`;
    assert.deepEqual(verdicts('y_spec.rb', changing), ['checks']);
  });

  it('still catches a Ruby test that really checks nothing', () => {
    assert.deepEqual(verdicts('z_spec.rb', `describe X do\n  it 'does a thing' do\n    thing.run\n    other.run\n  end\nend`), ['crash-only']);
  });

  it("PHPUnit's \$this->assert counts, which it never did before", () => {
    // The pattern was on the list from the start with a \b before the $, and a word boundary needs
    // a word character - so it had never once matched. 88 of laravel's 128 real tests were
    // "Tewip would not judge" as a result.
    const php = `<?php\nclass T extends TestCase {\n    public function testWords(): void\n    {\n        \$this->assertSame('a', Str::words('a b', 1));\n    }\n}`;
    assert.deepEqual(verdicts('StrTest.php', php), ['checks']);
  });

  it('reads a PHPUnit attribute and a @test docblock as well as the naming convention', () => {
    const attribute = `<?php\nclass T extends TestCase {\n    #[Test]\n    public function wordsAreLimited(): void\n    {\n        self::assertSame('a', \$x);\n    }\n}`;
    assert.deepEqual(verdicts('AttrTest.php', attribute), ['checks']);
  });

  it('reads a Rust #[test], and is not fooled by a lifetime', () => {
    // Every one of ripgrep's six #[test] attributes was discarded as being inside a string,
    // because `&'a str` looks like an opening quote that never closes.
    const rust = `fn helper<'a>(s: &'a str) -> &'a str { s }\n\n#[test]\nfn totals() {\n    assert_eq!(2, cart_total());\n}`;
    assert.deepEqual(verdicts('cart.rs', rust), ['checks']);
  });

  it('a Rust test that asserts nothing is still caught', () => {
    assert.deepEqual(verdicts('x.rs', `#[test]\nfn runs() {\n    let x = compute();\n    drop(x);\n}`), ['crash-only']);
  });

  it('a body that is one call to something defined elsewhere is a question, not an accusation', () => {
    // Rails's own test_constantize is one line calling a helper from a different file, which
    // asserts plenty. Saying "it compares no value" about that is a confident wrong answer.
    const delegating = `class T < Minitest::Test\n  def test_constantize\n    run_constantize_tests_on(&:constantize)\n  end\nend`;
    assert.deepEqual(verdicts('d_test.rb', delegating), ['cannot-tell']);
  });
});

describe('Ruby, and what is not actually a skip or a test', () => {
  const vouch = (text: string) => vouchFile('x_spec.rb', text).judgements;

  it('a skip inside a block the test hands to something else is not this test being skipped', () => {
    // rspec-core's own specs pass a block containing `skip "because"` to a helper, as the fixture
    // whose behaviour the test then asserts on. Reading it as "never runs" condemned the
    // reference implementation of RSpec.
    const text = `describe X do\n  it "reports a skipped example" do\n    result = capture do\n      skip "because"\n    end\n\n    expect(result.status).to eq :pending\n  end\nend`;
    const [only] = vouch(text);
    assert.equal(only.verdict, 'checks');
  });

  it('but a skip at the top of the body still means it never runs', () => {
    const text = `describe X do\n  it "is turned off" do\n    skip "flaky"\n    expect(1).to eq 2\n  end\nend`;
    assert.equal(vouch(text)[0].verdict, 'never-runs');
  });

  it('an it inside an it is a fixture, not a second test', () => {
    const text = `describe X do\n  it "applies the hook" do\n    describe_successfully do\n      it "inner" do\n        sequence << :example\n      end\n    end\n\n    expect(sequence).to eq [:example]\n  end\nend`;
    const judged = vouch(text);
    assert.equal(judged.length, 1, 'the inner it is test data for the outer one');
    assert.equal(judged[0].verdict, 'checks');
  });

  it('xit is still a test that never runs', () => {
    assert.equal(vouch(`describe X do\n  xit "later" do\n    expect(1).to eq 1\n  end\nend`)[0].verdict, 'never-runs');
  });
});

// Phase 42: the evidence has to be the test doing something.
//
// Found on saleor, 12,967 Python tests. Tewip condemned nothing it should not have - but all 166
// crash-only findings quoted the same evidence: `#`. Saleor writes its tests `# given`, `# when`,
// `# then`, and the reader was handed the comment marker as the proof. A finding whose evidence is
// one punctuation character is unusable even when it is correct, which is most of the harm a
// quality tool can do without being wrong.
describe('what the report quotes as evidence', () => {
  const evidenceFor = (file: string, text: string): string => vouchFile(file, text).judgements[0]?.evidence ?? '';

  it('skips the comment Saleor actually writes', () => {
    const evidence = evidenceFor(
      'test_gift_cards.py',
      [
        'def test_validate_gift_cards_allows_matching_assignment():',
        '    # given',
        '    card = gift_card(tag="main")',
        '    # when / then (no raise)',
        '    validate_gift_cards(card)',
      ].join('\n'),
    );
    assert.notEqual(evidence, '#');
    assert.doesNotMatch(evidence, /^#/, `evidence was ${JSON.stringify(evidence)}`);
    assert.match(evidence, /gift_card|validate/, 'the evidence should be a line that does something');
  });

  it('skips a JavaScript comment and a docstring the same way', () => {
    for (const [file, body] of [
      ['a.test.js', 'it("renders", () => {\n  // arrange\n  render(<App />);\n});'],
      ['b_test.py', 'def test_renders():\n    """Docstring."""\n    render(App)'],
    ] as const) {
      const evidence = evidenceFor(file, body);
      assert.doesNotMatch(evidence, /^(\/\/|""")/, `${file}: ${JSON.stringify(evidence)}`);
    }
  });

  it('falls back to the first line rather than quoting nothing', () => {
    // A test whose body is only comments has no line that does anything. Quoting the comment is
    // then honest; quoting an empty string is not, because it reads as though Tewip found nothing.
    const evidence = evidenceFor('c_test.py', 'def test_nothing():\n    # TODO\n    pass');
    assert.notEqual(evidence, '');
  });
});

// Phase 43: the single worst thing this project has done to date.
//
// Pointed at Keycloak - Red Hat's identity server, the login layer inside banks and governments -
// `vouch` called **166 correct tests worthless**. Every one of them was this, the standard Java way
// of writing "I expect this to throw":
//
//     try { parse(bad); Assert.fail(); } catch (VerificationException expected) { }
//
// That test fails properly the day `parse` stops throwing. `Assert.fail()` raises `AssertionError`,
// which extends `Error`, and `Error` is not an `Exception` - so `catch (VerificationException)` does
// not catch it, and neither would `catch (Exception)`. The rule had never read the caught type.
//
// Telling a developer their working test is worthless is the one failure that ends the conversation,
// whatever else the tool finds. Of the 166, zero could swallow an assertion.
describe('a catch that cannot catch an assertion', () => {
  const java = (body: string) => `public class T {\n  @Test\n  public void t() {\n${body}\n  }\n}`;

  it('leaves the expected-exception idiom alone', () => {
    for (const caught of ['VerificationException', 'NotFoundException', 'Exception', 'IOException', 'jakarta.ws.rs.ForbiddenException']) {
      const source = java(`    try {\n      parse("bad");\n      Assert.fail();\n    } catch (${caught} expected) {\n    }`);
      assert.notEqual(verdictOf('T.java', source), 'swallows-failure', `catch (${caught}) cannot catch an AssertionError`);
    }
  });

  it('still catches the one that really does discard the verdict', () => {
    for (const caught of ['Throwable', 'Error', 'AssertionError', 'java.lang.Throwable']) {
      const source = java(`    try {\n      Assert.assertEquals(2, compute());\n    } catch (${caught} t) {\n    }`);
      assert.equal(verdictOf('T.java', source), 'swallows-failure', `catch (${caught}) does swallow it`);
    }
  });

  it('reads a multi-catch, which swallows if any one of its types does', () => {
    const safe = java('    try {\n      parse("x");\n      Assert.fail();\n    } catch (IOException | SQLException e) {\n    }');
    assert.notEqual(verdictOf('T.java', safe), 'swallows-failure');
    const unsafe = java('    try {\n      Assert.assertTrue(ok());\n    } catch (IOException | Error e) {\n    }');
    assert.equal(verdictOf('T.java', unsafe), 'swallows-failure');
  });

  it('is not applied to the languages where catching Exception really does swallow it', () => {
    // C# is the near miss: NUnit, xUnit and MSTest all throw assertion failures that derive from
    // Exception, so `catch (Exception)` swallows them there. Same shape, opposite answer.
    const cs = '[Test]\npublic void T() {\n  try {\n    Assert.AreEqual(2, Compute());\n  } catch (Exception) {\n  }\n}';
    assert.equal(verdictOf('T.cs', cs), 'swallows-failure');
    const js = 'it("works", () => {\n  try {\n    expect(compute()).toBe(2);\n  } catch (e) {\n  }\n});';
    assert.equal(verdictOf('a.test.js', js), 'swallows-failure');
  });
});

// Phase 44: found by the corpus harness, in a test nobody would have re-read.
//
// OpenMRS's RefByUuidTest was called a tautology - "the check compares a value with itself, which no
// change to the code can falsify" - and its `assertTrue(true)` does compare nothing. But the real
// check is the `fail()` in its catch. Make the call throw and the test falsifies immediately.
describe('a bare fail() is a check', () => {
  it('is not a tautology when a fail() in the catch can still fail it', () => {
    const source = [
      'public class T {',
      '  @Test',
      '  public void refByUuid() {',
      '    try {',
      '      Object r = svc.get(x);',
      '      assertTrue(true, "no exception");',
      '    } catch (Exception e) {',
      '      fail("threw: " + e.getMessage());',
      '    }',
      '  }',
      '}',
    ].join('\n');
    assert.equal(verdictOf('T.java', source), 'checks');
  });

  it('still calls a real tautology a tautology', () => {
    const source = 'public class T {\n  @Test\n  public void t() {\n    assertTrue(true);\n  }\n}';
    assert.equal(verdictOf('T.java', source), 'tautology');
  });

  it('reads the shape that ends in a conditional fail', () => {
    // Keycloak's EventOptionsTest.testDeprecatedArePresent, and 43 others, were being called
    // crash-only. That test fails whenever an event type goes missing.
    const source = [
      'public class T {',
      '  @Test',
      '  public void deprecatedArePresent() {',
      '    List<String> left = remaining();',
      '    if (!left.isEmpty()) {',
      '      fail("Unknown event types " + left);',
      '    }',
      '  }',
      '}',
    ].join('\n');
    assert.equal(verdictOf('T.java', source), 'checks');
  });

  it('does not mistake a method whose name ends in Fail for the assertion', () => {
    const source = 'public class T {\n  @Test\n  public void t() {\n    shouldFail(x);\n    canFail(y);\n  }\n}';
    assert.notEqual(verdictOf('T.java', source), 'checks');
  });
});

// Phase 44, found by the corpus harness on its first run in CI: the same pinned commit gave 0
// swallows-failure on Windows and 3 on Linux, because Git for Windows checks source out with CRLF.
// Two of the three were false, and this is the rule that was wrong.
describe('a catch only swallows what its own try contains', () => {
  it('leaves a try around setup alone', () => {
    // Keycloak's admin-client tests open by deleting the thing they are about to create, so the
    // test does not depend on what the last run left behind, and assert afterwards - outside it.
    const source = [
      'it("create client scope and get by name", async () => {',
      '  try {',
      '    await kcAdminClient.clientScopes.delByName({ name });',
      '  } catch {',
      '    // ignore',
      '  }',
      '  await kcAdminClient.clientScopes.create({ name });',
      '  const scope = await kcAdminClient.clientScopes.findOneByName({ name });',
      '  expect(scope).to.be.ok;',
      '});',
    ].join('\n');
    assert.equal(verdictOf('a.spec.ts', source), 'checks');
  });

  it('still catches the assertion that really is inside the try', () => {
    const source = 'it("y", async () => {\n  try {\n    expect(scope).to.be.ok;\n  } catch {\n  }\n});';
    assert.equal(verdictOf('a.spec.ts', source), 'swallows-failure');
  });

  it('reads the expected-exception idiom as broken in TypeScript and sound in Java', () => {
    // The same shape, opposite answers, and both are right. A bare `catch` in TypeScript catches
    // everything the `fail()` throws; a typed `catch` in Java cannot catch an AssertionError.
    const ts = 'it("x", async () => {\n  try {\n    await getConfig({ id });\n    fail("should not find deleted config");\n  } catch {\n    // ignore\n  }\n});';
    assert.equal(verdictOf('a.spec.ts', ts), 'swallows-failure');
    const java = 'public class T {\n  @Test\n  public void t() {\n    try {\n      getConfig(id);\n      fail("should not find deleted config");\n    } catch (NotFoundException expected) {\n    }\n  }\n}';
    assert.equal(verdictOf('T.java', java), 'checks');
  });
});

// The answer must not depend on which machine read the file.
describe('line endings', () => {
  it('judges a CRLF file exactly as it judges an LF one', () => {
    const lf = 'public class T {\n  @Test\n  public void t() {\n    try {\n      Assert.assertEquals(2, f());\n    } catch (Throwable e) {\n    }\n  }\n}';
    assert.equal(verdictOf('T.java', lf), verdictOf('T.java', lf.split('\n').join('\r\n')));
  });
});

// Phase 45: .NET. The assumption shipped in Phase 43 - that C# is different because its assertion
// failures derive from Exception - held up: bitwarden/server's 10,875 tests produced no false
// accusation. What did not hold up was everything about skipping.
describe('a skipped test in .NET', () => {
  const cs = (body: string) => `using Xunit;\npublic class CollectionsControllerTests {\n${body}\n}`;

  it('reads xUnit, which skips by giving the test attribute a reason', () => {
    // Only `[Ignore]` was read, which is NUnit and MSTest. xUnit is the most used .NET framework by
    // a distance and has no separate attribute, so bitwarden's 43 skipped tests were reported as 1.
    for (const attribute of ['[Fact(Skip = "broken")]', '[Theory(Skip = "unreachable"), BitAutoData]', '[Fact(DisplayName = "x", Skip = "y")]']) {
      const source = cs(`  ${attribute}\n  public void T() {\n    Assert.Equal(1, x);\n  }`);
      assert.equal(verdictOf('CollectionsControllerTests.cs', source), 'never-runs', attribute);
    }
  });

  it('still reads the NUnit and MSTest spelling', () => {
    assert.equal(verdictOf('CollectionsControllerTests.cs', cs('  [Test]\n  [Ignore("later")]\n  public void T() {\n    Assert.AreEqual(1, x);\n  }')), 'never-runs');
  });

  it('does not read LINQ .Skip() as a test turning itself off', () => {
    // `collections.Skip(1).ToList()` is how .NET pages a sequence. The rule was written for Go's
    // `t.Skip()` and matched any identifier at all, so bitwarden's one and only never-runs finding,
    // before xUnit was understood, was a correct test that pages a list.
    const source = cs('  [Theory, BitAutoData]\n  public void T() {\n    collections.Skip(1).ToList().ForEach(c => c.Id = id);\n    Assert.Equal(1, x);\n  }');
    assert.equal(verdictOf('CollectionsControllerTests.cs', source), 'checks');
  });

  it('still reads Go, which is what that rule was for', () => {
    const go = 'func TestThing(t *testing.T) {\n\tt.Skip("flaky")\n\tif x != y { t.Fatal("no") }\n}';
    assert.equal(verdictOf('a_test.go', go), 'never-runs');
  });
});

describe('shapes real projects use that a naive reading condemns', () => {
  // Both of these were found by pointing vouch at the two languages it claimed and had never been
  // measured on: JavaScript, on alphagov/govuk-frontend, and Go, on gin-gonic/gin.

  it('reads the body of an it.each, not its destructured parameter', () => {
    // govuk-frontend: 19 of 21 accusations across 1,817 tests were this one shape. The first brace
    // after the title belongs to `({ name, className })`, so the body read back was the parameter
    // list - which contains no assertion - and nineteen correct tests were told they check nothing.
    const source = [
      `it.each(components)(`,
      `  'transforms component $name to class $className',`,
      `  ({ name, className }) => {`,
      `    expect(componentNameToClassName(name)).toBe(className);`,
      `  }`,
      `);`,
    ].join(String.fromCharCode(10));
    assert.equal(verdictOf('names.unit.test.mjs', source), 'checks');
  });

  it('reads the body of a plain destructuring callback too', () => {
    const source = `it('handles it', ({ page }) => {${String.fromCharCode(10)}  expect(page.title()).toBe('x');${String.fromCharCode(10)}});`;
    assert.equal(verdictOf('a.test.js', source), 'checks');
  });

  it('does not open a comment inside a string', () => {
    // gin's TestParseAccept parses an HTTP Accept header. The media type for 'anything' contains
    // both a slash-star and a star-slash, so a comment was opened inside the first string and
    // closed in the last assertion, and all five assertions in between became a single space.
    const anything = `*${'/'}*`;
    const source = [
      `func TestParseAccept(t *testing.T) {`,
      `	parts := parseAccept("text/html , application/xml;q=0.9,  ${anything} ;q=0.8")`,
      `	assert.Len(t, parts, 4)`,
      `	assert.Equal(t, "text/html", parts[0])`,
      `	assert.Equal(t, "${anything}", parts[3])`,
      `}`,
    ].join(String.fromCharCode(10));
    assert.equal(verdictOf('utils_test.go', source), 'checks');
  });

  it('still removes a real block comment', () => {
    const source = [
      `func TestThing(t *testing.T) {`,
      `	/* assert.Equal(t, 1, 2) is commented out`,
      `	   and so is everything here */`,
      `	doSomething()`,
      `}`,
    ].join(String.fromCharCode(10));
    // Not `checks`: the only assertion in the file is inside the comment, and a commented-out
    // assertion is the classic way a test stops checking. What is left is one call to a helper,
    // which vouch declines to judge rather than condemn.
    assert.equal(verdictOf('thing_test.go', source), 'cannot-tell');
  });
});
