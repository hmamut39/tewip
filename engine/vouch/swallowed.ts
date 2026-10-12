// Whether a test's own verdict is caught and thrown away.
//
// Split out of vouch.ts in Phase 44. It is the rule that has been wrong most often and most
// expensively - 166 false accusations in Phase 43, two more in Phase 44 - so it is worth having
// where it can be read on its own, with the reasoning that corrected it attached.
import { checksSomething } from './assertions.ts';
import { balanced, withoutComments } from './text.ts';
import type { Language } from './tests-in.ts';

/**
 * On the JVM, the only catches that can swallow a failing assertion.
 *
 * `Assert.fail()` and every JUnit matcher throw `AssertionError`, which extends `Error`, which
 * extends `Throwable` - and `Error` is **not** an `Exception`. So `catch (Exception e) { }` does not
 * catch a failing assertion, and neither does `catch (NotFoundException e) { }`. Only these do.
 *
 * This is not a detail. It is the difference between the standard Java way of writing "I expect this
 * to throw" -
 *
 *     try { parse(bad); Assert.fail(); } catch (VerificationException expected) { }
 *
 * - which is a correct test that fails properly when `parse` stops throwing, and a test that really
 * does discard its own verdict. Tewip could not tell them apart and called **166 correct Keycloak
 * tests worthless**, every one of them this idiom. Telling a developer their working test is
 * worthless is the one failure this project cannot afford, so the caught type is now read.
 *
 * C# is deliberately not here: NUnit, xUnit and MSTest all throw assertion failures that derive from
 * `Exception`, so `catch (Exception)` really does swallow them there. Same shape, opposite answer.
 */
const JVM_SWALLOWS = /^(?:java\.lang\.)?(?:Throwable|Error|AssertionError)$/;

/**
 * The `try` block that belongs to a `catch`, so the question can be asked about the right code.
 *
 * Walks back from the `catch` over the `}` that closes the try and finds its `{` by counting.
 */
function tryBlockBefore(body: string, catchAt: number): string {
  const close = body.lastIndexOf('}', catchAt);
  if (close === -1) return '';
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (body[i] === '}') depth += 1;
    else if (body[i] === '{') {
      depth -= 1;
      if (depth === 0) return body.slice(i + 1, close);
    }
  }
  return '';
}

/**
 * Everything inside a `try` whose `catch` discards what it caught. An assertion failure is an
 * exception, so a test shaped this way reports success however the code behaves - and a `catch` that
 * asserts, re-throws or fails the test is the legitimate version, which this leaves alone.
 */
export function swallowsFailure(body: string, checks: boolean, language: Language): string {
  if (!checks) return ''; // nothing to swallow; judged as no-assertion instead
  for (const hit of body.matchAll(/catch\s*(\([^)]*\))?\s*\{/g)) {
    // On the JVM the caught type decides it, and nearly every type leaves the assertion alone.
    if (language === 'jvm') {
      const caught = /\(\s*(?:final\s+)?([\w.]+)/.exec(hit[1] ?? '');
      // A multi-catch - `catch (A | B e)` - swallows only if one of its types does.
      const types = (hit[1] ?? '').replace(/[()]/g, '').split('|').map((t) => t.trim().split(/\s+/)[0]);
      if (!types.some((t) => JVM_SWALLOWS.test(t)) && !(caught && JVM_SWALLOWS.test(caught[1]))) continue;
    }
    // The catch has to be able to swallow *this test's verdict*, and it can only do that when the
    // assertion is inside its own try. Keycloak's admin-client tests open with
    //
    //     try { await delByName({ name }); } catch { /* ignore */ }
    //
    // to make sure the scope does not already exist, and then assert afterwards, outside it. The
    // rule asked "does this test assert anywhere, and is there an empty catch anywhere" and so
    // called three correct tests worthless. A try around setup is not a swallowed verdict.
    const guarded = tryBlockBefore(body, hit.index ?? 0);
    if (guarded !== '' && !checksSomething(guarded)) continue;
    const open = body.indexOf('{', hit.index ?? 0);
    const handler = balanced(body, open);
    if (handler === null) continue;
    const meaningful = withoutComments(handler).trim();
    const rescues = checksSomething(handler) || /\b(throw|raise|rethrow|fail|t\s*\.\s*(Error|Fatal)|pytest\s*\.\s*fail)\b/.test(handler);
    if (rescues) continue;
    // A handler that only logs, or does nothing at all, discards the failure.
    if (meaningful === '' || /^(console\s*\.\s*\w+\s*\([^;]*\)\s*;?|print\s*\([^;]*\)\s*;?|pass|;)$/.test(meaningful.replace(/\s+/g, ' ').trim())) {
      return meaningful === '' ? 'catch { }' : meaningful.slice(0, 120);
    }
  }
  return '';
}
