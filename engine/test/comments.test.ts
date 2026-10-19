// What counts as a comment, in a function that is handed every language.
//
// `withoutComments` has been wrong twice, both times on real code and both times caught by a
// project nobody had pointed it at:
//
//   Phase 93, on gin: `assert.Equal(t, "*/*", parts[3])` - the media type for "anything" contains
//   both a slash-star and a star-slash, so a comment was opened inside one string and closed in
//   another, and all five assertions between them became a space.
//
//   Phase 105, on discourse: `%r{https://matrix.org/.../m.room.message/*}` - a Ruby regex literal
//   ending in slash-star. The replacement treated an unclosed block comment as running to the end
//   of the body, which is what a compiler does, and a compiler is reading one language.
//
// Both directions matter and they pull against each other. Miss a comment and a commented-out
// assertion counts as an assertion, which is the oldest way a test stops checking. Take a comment
// that is not one and a real assertion disappears, and a thoroughly checked test gets accused of
// checking nothing. So each case below is stated as the whole sentence: this survives, that goes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withoutComments } from '../vouch/text.ts';
import { vouchFile } from '../vouch/vouch.ts';

const NL = String.fromCharCode(10);
const Q3 = '"""';
const BT = String.fromCharCode(96);
const lines = (...l: string[]) => withoutComments(l.join(NL));
const asserts = (text: string) => /assert|expect/.test(text);

/**
 * The verdict for one test, through the whole path.
 *
 * Stripping comments is only half of it: what the stripper leaves behind is then read as code, and
 * a comment cut out of the middle of a string leaves an unterminated quote. That is how bitwarden's
 * `var template = "Event #Type# occurred.";` lost its Assert.Equal - not because the stripper
 * removed the assertion, which is on the next line and survived, but because the quote it left open
 * swallowed everything after it. Asserting on `withoutComments` alone cannot see that, so the cases
 * that come from real projects are asked for the verdict instead.
 */
const verdictOf = (file: string, text: string): string => {
  const vouched = vouchFile(file, text);
  assert.equal(vouched.judgements.length, 1, `expected one test in ${file}: ${vouched.unread}`);
  return vouched.judgements[0].verdict;
};

describe('a comment marker inside a string is not a comment', () => {
  it('keeps a Go assertion whose string is a media type', () => {
    const out = lines('parts := parseAccept("text/html, */* ;q=0.8")', 'assert.Len(t, parts, 4)', 'assert.Equal(t, "*/*", parts[3])');
    assert.equal(asserts(out), true);
  });

  it('keeps a Ruby assertion below a regex ending in slash-star', () => {
    const out = lines('stub = stub_request(:put, %r{https://matrix.org/send/m.room.message/*})', 'expect(stub).to have_been_requested.once');
    assert.equal(asserts(out), true);
  });

  it('keeps a C# assertion whose string carries a hash', () => {
    // bitwarden's IntegrationTemplateProcessorTests. C# has no # comments, and the old stripper cut
    // at any ` #` - which did not remove the assertion on the next line, it left `"Event` open and
    // the string blanking took the body from there. The verdict is what shows it.
    const source = [
      '[Fact]',
      'public void ReplaceTokens_ReplacesSingleToken()',
      '{',
      '    var template = "Event #Type# occurred.";',
      '    var result = IntegrationTemplateProcessor.ReplaceTokens(template, eventMessage);',
      '    Assert.Equal(expected, result);',
      '}',
    ].join(NL);
    assert.equal(verdictOf('IntegrationTemplateProcessorTests.cs', source), 'checks');
  });

  it('keeps a Java assertion below an XPath containing a double slash', () => {
    // openmrs's SchemaOnlyTunerTest. Unlike the two above, this one is not a case that was ever
    // broken - checked against the old stripper and it read it correctly too. It is here because a
    // double slash inside a Java string is the shape those two were, and a guard for a shape that
    // has not failed yet is cheaper than finding out it can.
    const source = [
      '@Test',
      'public void shouldRemoveEmptyOrNullDefaultValues() {',
      '    XPath xPath = DocumentHelper.createXPath("//dbchangelog:column[@defaultValue]");',
      '    List<Node> nodes = xPath.selectNodes(document);',
      '    assertFalse(nodes.isEmpty());',
      '}',
    ].join(NL);
    assert.equal(verdictOf('SchemaOnlyTunerTest.java', source), 'checks');
  });

  it('keeps an assertion below a Python docstring that mentions a hash', () => {
    const out = lines('def test_price():', `    ${Q3}Checks the # discount rule.${Q3}`, '    assert total == 19');
    assert.equal(asserts(out), true);
  });

  it('keeps an assertion below a multi-line docstring', () => {
    const out = lines('def test_a():', `    ${Q3}`, '    Covers the # rule', `    ${Q3}`, '    assert x == 1');
    assert.equal(asserts(out), true);
  });

  it('keeps an assertion below a template literal holding a URL', () => {
    const out = lines('it("x", () => {', `  const u = ${BT}https://a.test/b${BT};`, '  expect(u).toBe(v);', '});');
    assert.equal(asserts(out), true);
  });
});

describe('a commented-out assertion is not an assertion', () => {
  it('removes a Python line comment', () => {
    assert.equal(asserts(lines('def test_a():', '    # assert total == 19', '    do_work()')), false);
  });

  it('removes a JavaScript line comment', () => {
    assert.equal(asserts(lines('it("x", () => {', '  // expect(a).toBe(b);', '  go();', '});')), false);
  });

  it('removes a block comment that closes', () => {
    assert.equal(asserts(lines('func T(t *testing.T) {', '  /* assert.Equal(t, 1, 2) */', '  go()', '}')), false);
  });

  it('removes a comment trailing real code', () => {
    assert.equal(asserts(lines('def test_b():', '    do_work()  # assert total == 19')), false);
  });

  it('removes a comment containing an apostrophe, without swallowing the rest', () => {
    // An unmatched quote inside a comment must not open a string that eats the body after it.
    const out = lines('def test_c():', "    # don't assert here", '    do_work()', '    assert x == 1');
    assert.equal(/assert x == 1/.test(out), true, 'the real assertion survives');
    assert.equal(/assert here/.test(out), false, 'the commented one does not');
  });

  it('does not read a URL in code as a line comment', () => {
    // `(^|\s)//` exists for this: https://x is not the start of a comment.
    const out = lines('const u = "https://a.test/b";', 'expect(u).toBe(v);');
    assert.equal(/https:/.test(out), true);
    assert.equal(asserts(out), true);
  });
});
