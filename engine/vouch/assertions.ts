// What counts as checking something, across the frameworks people actually use.
//
// This vocabulary is the whole accuracy of Phase 22, and its width is a lesson already paid for:
// in Phase 8 the wait fix refused six real Cypress fixes because "asserted" meant `expect(` and
// Cypress asserts with `.should(`, and refused the commonest shape of JavaScript unit test because
// `assert.equal` was not on the list either. A missing entry here does not produce a smaller
// answer, it produces a confident wrong one - Tewip telling somebody their test checks nothing when
// it checks plenty. So the list is broad, and anything not on it is undecided rather than damning.
const CHECKS: RegExp[] = [
  // JavaScript and TypeScript: Jest, Vitest, Chai, node:test, Playwright, Cypress, Supertest.
  /\bexpect\s*\(/,
  /\bexpect\s*\.\s*(soft|poll)\s*\(/,
  /\.\s*should\s*[.(]/,
  /\bshould\s*\.\s*not\b/,
  /\bassert\b\s*[.(]/,
  /\bassert(Equals?|True|False|Null|NotNull|That|Throws|Match|Contains|Rejects|Fails)\b/i,
  /\.\s*to\s*\.\s*(equal|be|deep|have|include|throw|match|exist)\b/,
  /\btoMatch(Snapshot|InlineSnapshot|ImageSnapshot)\s*\(/,
  /\bexpect(Type|TypeOf)\s*[<(]/,
  // AVA, tap and node-tap put their assertions on the test's own context object. Missing this made
  // Tewip condemn all 59 tests in chalk - a third repeat of the Phase 8 lesson, so the pattern here
  // is deliberately generous about what an assertion on `t` can be called.
  /\bt\s*\.\s*(is|not|deepEqual|notDeepEqual|like|true|false|truthy|falsy|throws(Async)?|notThrows(Async)?|regex|notRegex|snapshot|pass|equal|same|strictSame|ok|notOk|match|type|has|hasStrict|rejects|resolves)\b/,
  // Mocking libraries: verifying a call is a real check.
  /\b(verify|verifyNoMoreInteractions|toHaveBeenCalled)\b/,
  /\bsinon\s*\.\s*assert\b/,
  // Python: pytest, unittest, hypothesis.
  /(^|[^\w.])assert\s+[^=]/m,
  /\bself\s*\.\s*assert[A-Z]/,
  /\bpytest\s*\.\s*(raises|warns|approx|fail)\b/,
  /\bnp\s*\.\s*testing\s*\.\s*assert/,
  /\bassert_(frame|series|index)_equal\b/,
  // Java, Kotlin, C#, Scala.
  /\bAssert(ions)?\s*\./,
  /\bassertThat\s*\(/,
  /\bShould(Be|NotBe|Throw|Contain)\b/,
  /\bFluentActions\b/,
  // Go.
  /\bt\s*\.\s*(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b/,
  /\b(require|assert)\s*\.\s*[A-Z]\w+\s*\(/,
  // Ruby. The snake_case family is the whole of minitest and most of Rails's own suite, and
  // `assert_equal "x", y` has no parentheses - so the generic `assert` patterns above, which all
  // want a `.` or a `(`, matched none of it. Without this, 121 of the 154 real tests in Rails's
  // activesupport string_ext_test.rb were reported as comparing no value. That is the Phase 8
  // lesson for the fourth time: a missing entry here does not produce a smaller answer, it
  // produces a confident wrong one.
  /\b(assert|refute)_\w+/,
  /\bassert\s+[^=\n]/,
  /\bexpect\s*\(.*\)\s*\.\s*(to|not_to|to_not)\b/,
  // RSpec's block form, which is how every raise_error, change and output matcher is written:
  // `expect { thing }.to raise_error(...)`. Missing it reported rspec-core's own specs - the
  // reference implementation - as containing tests that cannot fail.
  /\bexpect\s*\{[\s\S]*?\}\s*\.\s*(to|not_to|to_not)\b/,
  /\bis_expected\s*\.\s*to\b/,
  /\.\s*(must_equal|must_be|wont_equal|wont_be)\b/,
  // PHP: PHPUnit on the instance or statically, and Pest's expectation chain.
  //
  // No `\b` before the `$`. A word boundary needs a word character on one side, `$` is not one,
  // and the character before it in real code is a space - so `/\b\$this/` matched nothing, ever.
  // This pattern was on the list from the start and had never once fired: 88 of the 128 real tests
  // in laravel/framework's SupportStrTest came back as "Tewip would not judge" because the
  // `assertSame(...)` in them was being read as an unknown helper that might assert.
  /\$this\s*->\s*assert/,
  /\b(?:self|static|Assert)\s*::\s*assert/,
  /\bexpect\s*\(.*\)\s*->\s*\w+/,
  // Rust. A #[should_panic] test asserts by panicking, so it can fail without an assert in it.
  /\bassert(_eq|_ne|_matches)?!\s*\(/,
  /\bdebug_assert(_eq|_ne)?!\s*\(/,
  /#\s*\[\s*should_panic/,
  // Robot Framework and other keyword styles: a line that reads as a check.
  /^\s*Should\s+(Be|Not|Contain|Match)\b/im,
];

/** Does this text check anything at all, by any framework's idea of checking? */
export function checksSomething(text: string): boolean {
  return CHECKS.some((pattern) => pattern.test(text));
}

/**
 * An `expect(...)` that was never finished: no matcher was called on it, so it runs clean and proves
 * nothing. `expect(user).toBe(x)` checks; `expect(user);` does not, and neither does a matcher left
 * as a property - `expect(user).toBeDefined;` is a reference to a function nobody called.
 *
 * Both shapes are ordinary typos that no test run can catch, which is exactly why they survive.
 */
export function unfinishedExpectations(body: string): string[] {
  const found: string[] = [];
  for (const line of body.split(String.fromCharCode(10))) {
    const text = line.trim();
    if (!/^(await\s+)?expect(\.soft)?\s*\(/.test(text)) continue;
    const after = afterBalanced(text, text.indexOf('('));
    if (after === null) continue; // the call spans more lines; judged as part of the whole body
    const rest = after.trim();
    if (rest === '' || rest === ';') found.push(text);
    // A matcher named but not called: `.toBeVisible;` or `.toBeVisible` at the end of a statement.
    else if (/^\.\s*[A-Za-z$_][\w$]*\s*;?$/.test(rest)) found.push(text);
  }
  return found;
}

/** What follows the balanced bracket that opens at `from`, or null when it never closes here. */
function afterBalanced(text: string, from: number): string | null {
  let depth = 0;
  let quote = '';
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(i + 1);
    }
  }
  return null;
}

/**
 * A check that cannot fail because both sides are the same literal, or the same expression.
 * `expect(true).toBe(true)`, `assertEquals(1, 1)`, `assert x == x`. These appear in generated tests
 * and in tests somebody left as a placeholder, and they pass forever.
 */
export function tautologies(body: string): string[] {
  const found: string[] = [];
  const literal = String.raw`(?:true|false|null|None|nil|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")`;
  const patterns = [
    new RegExp(String.raw`expect\s*\(\s*(${literal})\s*\)\s*\.\s*(?:to\s*\.\s*)?(?:toBe|toEqual|toStrictEqual|equal|eq|is)\s*\(\s*(${literal})\s*\)`),
    new RegExp(String.raw`assert(?:Equals?|\.equal|\.strictEqual|\.deepEqual)\s*\(\s*(${literal})\s*,\s*(${literal})\s*\)`),
    new RegExp(String.raw`^\s*assert\s+(${literal})\s*==\s*(${literal})\s*$`),
  ];
  for (const line of body.split(String.fromCharCode(10))) {
    for (const pattern of patterns) {
      const hit = pattern.exec(line);
      if (hit && same(hit[1], hit[2])) found.push(line.trim());
    }
    // The same name on both sides of a comparison, which no value can falsify.
    const self = /(?:expect\s*\(\s*([\w.$]+)\s*\)\s*\.\s*(?:toBe|toEqual|equal)\s*\(\s*([\w.$]+)\s*\)|^\s*assert\s+([\w.$]+)\s*==\s*([\w.$]+)\s*$)/.exec(line);
    if (self) {
      const [left, right] = [self[1] ?? self[3], self[2] ?? self[4]];
      if (left && right && left === right && !/^(true|false|null|undefined|None)$/.test(left)) found.push(line.trim());
    }
    // `assert.ok(true)`, `assert(true)`, `assertTrue(true)`: a check whose subject is the answer. Found
    // while writing a realistic fixture for the verdict - the commonest placeholder in Node's own test
    // style, and the vocabulary did not have it.
    if (/\b(assert(?:\.(?:ok|isTrue|isOk))?|assertTrue|expect)\s*\(\s*(?:true|1|!0)\s*[,)]/.test(line)) found.push(line.trim());
    // `assert True` / `assert 1`: a constant truth written as a statement.
    if (/^\s*assert\s+(True|true|1)\s*(,|$)/.test(line)) found.push(line.trim());
  }
  return [...new Set(found)];
}

/** Two literals that mean the same value, allowing for how each language spells truth. */
function same(a: string, b: string): boolean {
  const clean = (v: string) => v.trim().replace(/^['"]|['"]$/g, '');
  return clean(a) === clean(b);
}
