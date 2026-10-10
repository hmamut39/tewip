// Phase 25: run the tests that could notice this change, and say exactly what is being given up.
//
// This is the first thing in Tewip that saves money rather than finding defects, and it is the reason a
// company installs a tool on day one: a suite that takes forty minutes is a suite people stop running.
// Vendors sell this as a prediction - a model guesses which tests matter. A guess is the wrong shape for
// the job, because the cost of being wrong is a bug reaching production, and nobody can audit a guess.
//
// So selection here is a **refusal problem**, not a prediction problem. Skipping a test is a claim that
// it could not have noticed the change, and a claim needs evidence:
//
//   - an import path from the test to a changed file is evidence (it is a fact in the source);
//   - no import path, in a project whose tests drive a browser, is **not** evidence of anything - the
//     test reaches the code through the running application, so nothing may be skipped;
//   - a changed build file, config, lockfile or shared fixture can affect anything, so nothing may be
//     skipped;
//   - a test that has been failing or flaking lately is an unknown, and an unknown is never a skip.
//
// Where it cannot prove a test irrelevant, it runs it. That makes the saving smaller than a vendor's
// slide and the claim one a release manager can actually rely on.
export interface Candidate {
  testFile: string;
  /** Test ids inside it that Tewip has seen fail recently, if any. */
  recentlyFailed: string[];
  /**
   * True when the test reads the repository at run time - a guard that walks every source file looking
   * for a forbidden pattern, a snapshot of the public API, a licence header check. Any file can break
   * one of these, so they are never skipped. This project has such a guard, and a change to an
   * unrelated module really does fail it.
   */
  readsTheRepo?: boolean;
}

export interface PickInput {
  /** Files the change touched, relative to the root, with forward slashes. */
  changed: string[];
  /** Every test file in the project. */
  tests: Candidate[];
  /** For each changed source file, the test files that import or reach it. Empty means "nothing found". */
  reaching: Map<string, Array<{ testFile: string; how: string }>>;
  /** True when this project's tests drive a browser, so imports do not describe what a test exercises. */
  browserTests: boolean;
  /**
   * Changed files that nothing in the project refers to at all - no import, no mention of their name in
   * any source or test. Nothing can notice a change to them, so they do not widen the run.
   */
  unreferenced: string[];
  /** True when the project keeps no run history, so "it has not failed lately" is an assumption. */
  noHistory: boolean;
}

export interface Picked {
  mustRun: Array<{ testFile: string; why: string }>;
  skipped: Array<{ testFile: string; why: string }>;
  /** Non-empty when Tewip will not narrow the suite at all. The reason is the message. */
  runEverything: string;
  /** Changed files nothing could be traced from. */
  opaque: string[];
}

/** A changed file that can affect anything, so no test can be ruled out because of it. */
const GLOBAL = [
  { match: /(^|\/)(package|package-lock|yarn|pnpm-lock|bun\.lock|requirements|pyproject|poetry\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle|Gemfile|composer\.json|Cargo\.toml)/i, why: 'it changes the dependencies, which every test runs against' },
  { match: /(^|\/)(\.github|\.gitlab-ci|Jenkinsfile|azure-pipelines|\.circleci|Dockerfile|docker-compose|Makefile)/i, why: 'it changes how the suite is built or run' },
  { match: /(^|\/)(jest|vitest|playwright|cypress|karma|babel|tsconfig|webpack|vite|rollup|eslint|tox|pytest|conftest)\b[\w.]*\.(json|js|ts|cjs|mjs|ini|cfg|toml|yaml|yml)$/i, why: 'it is test or build configuration, which applies to the whole suite' },
  { match: /(^|\/)(conftest\.py|setup\.(js|ts|py)|global-setup\.[jt]s|jest\.setup\.[jt]s|test-setup\.[jt]s)$/i, why: 'it is shared setup, which runs before every test' },
  { match: /(^|\/)(fixtures?|helpers?|support|mocks?|__mocks__|testdata|factories)\//i, why: 'it is shared test support, which any test may use' },
];

const SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|java|kt|go|cs|rb|php|vue|svelte|scala|swift)$/i;
const IS_TEST = /(^|\/)(tests?|spec|specs|__tests__|e2e)\/|[._-](test|tests|spec|specs)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs)$/i;
/** Documentation and assets: a test cannot notice these, so they never widen the run. */
const INERT = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|pdf|lock|csv)$|(^|\/)(LICENSE|CODEOWNERS|\.gitignore|\.editorconfig|\.prettierrc)/i;

export function pick(input: PickInput): Picked {
  // Global first, then inert. The other order called `requirements.txt` documentation because of its
  // extension and then reported that a dependency change could not affect any test.
  const changed = input.changed.filter((f) => GLOBAL.some((g) => g.match.test(f)) || !INERT.test(f));
  const picked: Picked = { mustRun: [], skipped: [], runEverything: '', opaque: [] };

  if (changed.length === 0) {
    return { ...picked, runEverything: 'nothing in this change can affect a test result - only documentation, assets or lockless files were touched. Running nothing is also an option.' };
  }

  // Anything global stops selection outright, and names the file that did it.
  for (const file of changed) {
    const global = GLOBAL.find((g) => g.match.test(file));
    if (global) return { ...picked, runEverything: `${file} cannot be narrowed around: ${global.why}` };
  }

  const changedSource = changed.filter((f) => SOURCE.test(f) && !IS_TEST.test(f));
  const changedTests = changed.filter((f) => IS_TEST.test(f));

  // A changed file nothing can be traced from. For a browser suite this is the normal case rather than a
  // gap - the test reaches the code through the running application - so the honest answer is to run
  // everything and say why, not to claim the tests are unrelated.
  // A file no test imports may still be reachable in a way imports do not show. But a file that nothing
  // in the project refers to **at all** - not imported, not named in any source or test - cannot be
  // noticed by any test, and treating that as "cannot tell" made the command useless: in this very
  // repository a change to the command-line dispatcher, which tests only read as text, forced the whole
  // suite. So the two cases are separated, and only a genuine unknown stops selection.
  picked.opaque = changedSource.filter((f) => (input.reaching.get(f) ?? []).length === 0 && !input.unreferenced.includes(f));
  if (picked.opaque.length > 0) {
    return {
      ...picked,
      runEverything: input.browserTests
        ? `these tests drive a browser, so what a test exercises is not written in its imports: ${picked.opaque.slice(0, 3).join(', ')} cannot be traced to any test, and skipping on that basis would be a guess`
        : `no test can be traced to ${picked.opaque.slice(0, 3).join(', ')}${picked.opaque.length > 3 ? ` and ${picked.opaque.length - 3} more` : ''}. Tewip will not take that as proof the suite is unaffected - code can be reached in ways an import does not show (dependency injection, a plugin registry, a dynamic import)`,
    };
  }

  const why = new Map<string, string>();
  const add = (testFile: string, reason: string) => {
    if (!why.has(testFile)) why.set(testFile, reason);
  };

  // A test the change itself edited always runs: whatever it now checks, nobody has seen it run yet.
  for (const file of changedTests) add(file, 'this change edits it');

  for (const [file, reaches] of input.reaching) {
    if (!changedSource.includes(file)) continue;
    for (const reach of reaches) add(reach.testFile, `it ${reach.how} ${file}`);
  }

  // A test that walks the repository can be broken by any file in it, so it always runs.
  for (const test of input.tests) {
    if (test.readsTheRepo) add(test.testFile, 'it reads the repository itself, so any changed file can break it');
  }

  // An unknown is not a skip. A test that has been failing or flaking lately gets another run, because
  // "it is unrelated to this change" and "it is broken for another reason" are different statements and
  // only the first is a reason to skip.
  for (const test of input.tests) {
    if (test.recentlyFailed.length > 0) add(test.testFile, `it failed recently (${test.recentlyFailed.length} time(s)), so its state is unknown rather than unrelated`);
  }

  picked.mustRun = [...why.entries()].map(([testFile, reason]) => ({ testFile, why: reason })).sort((a, b) => a.testFile.localeCompare(b.testFile));
  picked.skipped = input.tests
    .filter((t) => !why.has(t.testFile))
    .map((t) => ({ testFile: t.testFile, why: 'nothing it imports, directly or through another module, reaches anything this change touched' }))
    .sort((a, b) => a.testFile.localeCompare(b.testFile));

  if (picked.mustRun.length === 0) {
    return {
      ...picked,
      runEverything: `nothing in this project refers to ${changed.slice(0, 3).join(', ')}, so no test can notice the change. Running nothing is defensible; running the suite costs nothing but time.`,
    };
  }

  // Selecting everything is not a failure, but it should be said plainly rather than dressed up as a saving.
  if (picked.skipped.length === 0 && picked.mustRun.length > 0) {
    picked.runEverything = 'every test in the project reaches something this change touched, so there is nothing to skip';
  }
  if (input.noHistory && picked.skipped.length > 0) {
    picked.runEverything = picked.runEverything || '';
  }
  return picked;
}

/** What the selection is worth, and what it rests on. */
export function renderPick(picked: Picked, total: number, command: string, noHistory: boolean): string {
  const lines = ['# Which tests could notice this change?', ''];

  if (picked.runEverything) {
    lines.push(
      `**Run the whole suite.** ${picked.runEverything}.`,
      '',
      'Tewip narrows a test run only when it can show that the tests it leaves out could not have noticed',
      'the change. It cannot show that here, so it is not asking you to take the risk.',
      '',
    );
    if (picked.opaque.length > 0) {
      lines.push('Changed files nothing could be traced from:', '', ...picked.opaque.slice(0, 10).map((f) => `- ${f}`), '');
    }
    return lines.concat(tail(noHistory)).join(String.fromCharCode(10));
  }

  const kept = picked.mustRun.length;
  const share = total > 0 ? Math.round((kept / total) * 100) : 100;
  lines.push(
    `**${kept} of ${total} test file(s)** could notice it - ${share}% of the suite. ${picked.skipped.length} can be left out.`,
    '',
    '```',
    command,
    '```',
    '',
    `## Why these ${kept} run`,
    '',
    ...picked.mustRun.slice(0, 30).map((m) => `- \`${m.testFile}\` — ${m.why}`),
    ...(picked.mustRun.length > 30 ? [`- …and ${picked.mustRun.length - 30} more`] : []),
    '',
    `## What you are giving up (${picked.skipped.length})`,
    '',
    'Each of these is left out because of a fact about the source, not a prediction:',
    '',
    ...picked.skipped.slice(0, 15).map((s) => `- \`${s.testFile}\``),
    ...(picked.skipped.length > 15 ? [`- …and ${picked.skipped.length - 15} more`] : []),
    '',
  );
  return lines.concat(tail(noHistory)).join(String.fromCharCode(10));
}

const tail = (noHistory: boolean): string[] => [
  '---',
  '',
  'How this decides: a test runs when it imports a changed file, or reaches one through another module,',
  'or when the change edits the test itself, or when it has failed recently - an unknown is never a skip.',
  'It runs everything when the change touches dependencies, build or test configuration, shared setup or',
  'shared fixtures, or when a changed file cannot be traced to any test at all. No model is called.',
  ...(noHistory
    ? ['', 'This project keeps no run history, so "it has not failed lately" could not be checked for any test.', 'Run `tewip explain` on your CI reports and the next selection will know more.']
    : []),
];
