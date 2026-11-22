// Does anything test the change at all? The row a release decision leans on hardest.
//
// Split out of verdict.ts in Phase 217, when four fixes to this one question took that file past
// this project's 300-line rule. It is the right seam: every branch here answers the same question
// and the differences between them are all about what the evidence does and does not support.
//
// The order is the order of strength. A coverage report records what ran and settles it either
// way; imports are a fact about the source; and below those sit three different kinds of not
// knowing, which this project exists to tell apart from a no.
import type { Check, Evidence } from './evidence.ts';

/** How much a way of reaching the change is worth, lowest first. */
const STRENGTH = (how: string): number => (how === 'imports it' ? 0 : how.startsWith('imports') ? 1 : 2);

export function isItTested(evidence: Evidence): Check {
  if (evidence.changedSource.length === 0) {
    return { question: 'Is the changed code tested?', standing: 'not-applicable', answer: 'this change touches no source file', decidedBy: 'the diff' };
  } else if (evidence.coverage && evidence.coverage.notExecuted.length > 0) {
    // The report names these files and never ran a line of them. That is not "cannot say" - it is
    // the suite being measured and found not to reach this code.
    return {
      question: 'Is the changed code tested?',
      standing: 'not-met',
      answer: `${evidence.coverage.notExecuted.slice(0, 3).join(', ')} ${evidence.coverage.notExecuted.length === 1 ? 'is' : 'are'} in ${evidence.coverage.from} with no line executed, so the suite runs none of this`,
      decidedBy: `${evidence.coverage.from}, which records what ran rather than what imports what`,
    };
  } else if (evidence.coverage && evidence.coverage.executed.length > 0) {
    // Settles the question imports could not. Phases 46 and 52 both ended at "cannot say" here, on
    // every real Saleor pull request, because a test that posts a GraphQL query never imports the
    // resolver chain it exercises.
    return {
      question: 'Is the changed code tested?',
      standing: 'met',
      answer: `the suite executes ${evidence.coverage.executed.slice(0, 3).join(', ')}${evidence.coverage.executed.length > 3 ? ` and ${evidence.coverage.executed.length - 3} more` : ''}`,
      decidedBy: `${evidence.coverage.from}, which records what ran rather than what imports what`,
    };
  } else if (evidence.covering.length === 0 && evidence.changedTests.length > 0) {
    // Nothing *imports* the changed file, and the same change ships tests. Coverage here is followed
    // through imports, which is a fact rather than a name match - and which cannot see a test that
    // reaches the code through a framework's entry point. A Saleor test posts a GraphQL query and
    // asserts the error it gets back; the resolver chain in between is never imported by name.
    //
    // Found in Phase 46 by running this verdict over six real merged Saleor pull requests. Four came
    // back **Not ready**, and all four shipped a test for exactly the change they were making. A gate
    // that says "not ready" to a correct pull request is uninstalled within a week, and it is the
    // same overclaim as a false accusation, pointed at the change instead of at a test.
    //
    // So: cannot say. Which is this project's whole point, and this check had no way to say it.
    return {
      question: 'Is the changed code tested?',
      standing: 'not-checked',
      answer:
        `no test imports or reaches ${evidence.changedSource.slice(0, 3).join(', ')}, but this change also ` +
        `edits ${evidence.changedTests.length} test file(s). Coverage is followed through imports, which cannot see a test ` +
        'that reaches the code through a GraphQL resolver, an HTTP route or any other framework entry point - ' +
        'so whether those tests cover this is a question the imports cannot answer',
      decidedBy: 'imports followed through the source, which is a fact rather than a name match',
    };
  } else if (evidence.covering.length === 0 && evidence.selfTested.length > 0) {
    // The tests are inside the files that changed, where no import graph will ever find them.
    //
    // Rust puts them in a `#[cfg(test)] mod tests` at the bottom of the file; Go in an in-package
    // `_test`; Python in an `if __name__` block. Nothing imports any of those. The branch below
    // used to catch these and say **"nothing here could notice a mistake in it"**, measured on
    // ripgrep's clippy commit, where `crates/regex/src/ban.rs` and `crates/regex/src/strip.rs`
    // each carry their own `#[test]`. That is the Phase 46 overclaim - a gate saying "not ready"
    // to a correct change - pointed at a language whose tests do not live where it looked.
    //
    // Not "yes": a test in the file is not proof it covers the lines this change wrote. Not "no"
    // either, which is the one answer the evidence rules out. Phase 217.
    return {
      question: 'Is the changed code tested?',
      standing: 'not-checked',
      answer:
        `no separate test file imports or reaches ${evidence.changedSource.slice(0, 3).join(', ')}, but ` +
        `${evidence.selfTested.length} of the changed file(s) declare tests inside themselves - ` +
        `${evidence.selfTested.slice(0, 3).join(', ')}. Coverage here is followed through imports, and nothing ` +
        'imports a test that sits in the file it tests, so whether those tests reach the lines this change ' +
        'wrote is a question the imports cannot answer',
      decidedBy: 'imports followed through the source, and tests read out of the changed files themselves',
    };
  } else if (evidence.covering.length === 0 && evidence.importsNotFollowed.length > 0) {
    // A zero from a language whose imports cannot be read is not a zero.
    //
    // Coverage here is followed by looking for `from x`, `import x` and `require(x)`. C# writes
    // `using Bit.Core;`, Go imports a package and never a file, Java's `import org.keycloak.X`
    // never equals a repo-relative path, Ruby's `require_relative` is not `require(`. Over the
    // corpus - keycloak's 1,958 test files, bitwarden's 1,173, discourse's 765 - not one import
    // in any of those four languages resolved. The branch below took that for proof and said
    // **"nothing here could notice a mistake in it"** about `src/Core/Constants.cs`, whose types
    // are named in 63 of bitwarden's test files, and failed the whole change on it.
    //
    // The row below this one still answers for every language, because `vouch` reads all of them;
    // it is only reaching from a test to a source file that stops here. Phase 217.
    return {
      question: 'Is the changed code tested?',
      standing: 'not-checked',
      answer:
        `no test was found reaching ${evidence.changedSource.slice(0, 3).join(', ')}, but coverage here is followed ` +
        `through imports and ${evidence.importsNotFollowed.length} of the changed file(s) ` +
        `${evidence.importsNotFollowed.length === 1 ? 'is' : 'are'} in a language whose ` +
        'imports Tewip cannot read - C# names a namespace, Go imports a package rather than a file, and in Java an ' +
        'import is never a path. So this is not evidence that nothing tests them. A coverage report from the test ' +
        'run this project already does would answer it: point Tewip at one and this row becomes a measurement',
      decidedBy: 'imports followed through the source, which this language does not express as imports',
    };
  } else if (evidence.covering.length === 0) {
    return {
      question: 'Is the changed code tested?',
      standing: 'not-met',
      answer: `no test imports or reaches ${evidence.changedSource.slice(0, 3).join(', ')}, and this change adds no test either, so nothing here could notice a mistake in it`,
      decidedBy: 'imports followed through the source, which is a fact rather than a name match',
    };
  } else {
    return {
      question: 'Is the changed code tested?',
      standing: 'met',
      // Named with how each one reaches it, and the direct importers named first.
      //
      // "79 test file(s) reach it" over three bare filenames reads the same whether a test imports
      // the changed file or arrives at it through six hops, and those are not the same evidence: a
      // DTO that half the project imports is "reached" by almost every test in it. On immich's
      // `config.dto.ts` the three it chose to name were exif specs, while the file's own
      // `config.dto.spec.ts` sat in the same list. The qualifier was already computed and was
      // being dropped on the way to the sentence. Phase 216.
      answer: `${evidence.covering.length} test file(s) reach it: ${[...evidence.covering]
        // Strongest first: naming the file, then importing the folder it sits in, then distance.
        // `startsWith('imports')` was enough while "imports it" was the only strong kind; it now
        // also catches "imports the package it is in", which is the weaker one. Phase 217.
        .sort((a, b) => STRENGTH(a.how) - STRENGTH(b.how))
        .slice(0, 3)
        .map((c) => `${c.testFile} (${c.how})`)
        .join(', ')}`,
      decidedBy: 'imports followed through the source',
    };
  }
}
