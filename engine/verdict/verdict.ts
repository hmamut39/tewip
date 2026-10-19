// Phase 24: is this work actually done?
//
// Everything Tewip has built answers one question each. A team reviewing an agent's pull request has to
// run six commands and assemble the answer themselves, which means in practice they run none and merge
// on a green tick. This composes the answers into one verdict, from evidence that was already measured,
// and it is built to be **unimpressive**: every check can come back "not checked", and the verdict says
// so rather than rounding up to approval.
//
// Three rules, and the third is the one that makes it worth anything:
//
// 1. Nothing new is judged here. Every check is a layer that has its own measured accuracy, and this
//    file only orders them and reports what they said.
// 2. The order is fixed and published, like the pursue policy: a person can predict the answer.
// 3. **"Cannot say" is a real answer**, and it is not "ready". A gate that only ever says yes or no has
//    to guess when it does not know, and a guess that says "ready" is how this whole category of tool
//    loses its reputation.
export type Standing = 'met' | 'not-met' | 'not-applicable' | 'not-checked';

/** The questions that cannot be skipped on the way to "ready". */
const ESSENTIAL = ['Is everything passing?', 'Is the changed code tested?'];

export interface Check {
  /** What was asked, in a reviewer's words. */
  question: string;
  standing: Standing;
  /** The answer, with the evidence that supports it. */
  answer: string;
  /** Which layer decided, so the claim can be traced to something with a measured accuracy. */
  decidedBy: string;
}

export type Verdict = 'ready' | 'not-ready' | 'cannot-say';

export interface Decision {
  verdict: Verdict;
  /** One sentence a person can act on. */
  headline: string;
  checks: Check[];
  /** What this verdict says nothing about. Always non-empty. */
  notChecked: string[];
}

export interface Evidence {
  /** Source files the change touched (not tests). */
  changedSource: string[];
  /** Test files the change touched. */
  changedTests: string[];
  /** Test files that reach the changed source, and how. */
  covering: Array<{ testFile: string; how: string }>;
  /**
   * What a coverage report the project already produces says about the changed files, when there is
   * one. Imports cannot see a test that posts a GraphQL query or hits an HTTP route; a coverage
   * report can, because it records what actually ran.
   */
  coverage?: { from: string; executed: string[]; notExecuted: string[] };
  /** Tests in the change that could never fail. */
  cannotFail: Array<{ name: string; file: string; line: number; why: string }>;
  /** Tests in the change that compare no value. */
  crashOnly: number;
  /** Tests in the change vouch would not call either way. */
  couldNotJudge: number;
  /** Deliberate changes that no covering test noticed. Null when proving was not run. */
  unnoticed: Array<{ file: string; line: number; kind: string }> | null;
  /** Failures in the most recent kept run that touch the changed files. */
  failingNow: Array<{ testId: string; category: string }>;
  /** True when this project keeps no run history, so "nothing is failing" would be an assumption. */
  noHistory: boolean;
  /** Scenarios of a kept plan that the change relates to and nothing covers. Null when no plans exist. */
  uncovered: Array<{ id: string; title: string }> | null;
  /** Rules from this project's own standards that the change breaks. Null when it has written none. */
  brokenRules: Array<{ standard: string; file: string; line: number; why: string }> | null;
}

/**
 * The verdict, in a fixed order: what is broken first, then what cannot be believed, then what is
 * missing, and only then "ready".
 */
export function decide(evidence: Evidence): Decision {
  const checks: Check[] = [];

  // 1. Is anything failing right now? Nothing else matters while it is.
  //
  // Asked as "Is everything passing?" so that a yes is good news, like every other row. Phrased
  // the other way round, the table said **no** to "Is anything failing?" when a test really was
  // failing - true of the standing, backwards as an answer, and the table is the part a reviewer
  // scans before anything else. The headline said Not ready and named the test either way; the
  // row beside it still read like reassurance.
  if (evidence.noHistory) {
    checks.push({ question: 'Is everything passing?', standing: 'not-checked', answer: 'no run has been kept for this project, so Tewip has not seen a test result here. Run `tewip explain <report>` in CI and it will know.', decidedBy: 'kept history' });
  } else if (evidence.failingNow.length > 0) {
    checks.push({
      question: 'Is everything passing?',
      standing: 'not-met',
      answer: `${evidence.failingNow.length} test(s) touching this change failed in the last run: ${evidence.failingNow.slice(0, 3).map((f) => `${f.testId} (${f.category})`).join(', ')}`,
      decidedBy: 'the triage rules and model, measured on real CI data',
    });
  } else {
    checks.push({ question: 'Is everything passing?', standing: 'met', answer: 'nothing touching this change failed in the last kept run', decidedBy: 'kept history' });
  }

  // 2. Does anything test the change at all?
  if (evidence.changedSource.length === 0) {
    checks.push({ question: 'Is the changed code tested?', standing: 'not-applicable', answer: 'this change touches no source file', decidedBy: 'the diff' });
  } else if (evidence.coverage && evidence.coverage.notExecuted.length > 0) {
    // The report names these files and never ran a line of them. That is not "cannot say" - it is
    // the suite being measured and found not to reach this code.
    checks.push({
      question: 'Is the changed code tested?',
      standing: 'not-met',
      answer: `${evidence.coverage.notExecuted.slice(0, 3).join(', ')} ${evidence.coverage.notExecuted.length === 1 ? 'is' : 'are'} in ${evidence.coverage.from} with no line executed, so the suite runs none of this`,
      decidedBy: `${evidence.coverage.from}, which records what ran rather than what imports what`,
    });
  } else if (evidence.coverage && evidence.coverage.executed.length > 0) {
    // Settles the question imports could not. Phases 46 and 52 both ended at "cannot say" here, on
    // every real Saleor pull request, because a test that posts a GraphQL query never imports the
    // resolver chain it exercises.
    checks.push({
      question: 'Is the changed code tested?',
      standing: 'met',
      answer: `the suite executes ${evidence.coverage.executed.slice(0, 3).join(', ')}${evidence.coverage.executed.length > 3 ? ` and ${evidence.coverage.executed.length - 3} more` : ''}`,
      decidedBy: `${evidence.coverage.from}, which records what ran rather than what imports what`,
    });
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
    checks.push({
      question: 'Is the changed code tested?',
      standing: 'not-checked',
      answer:
        `no test imports or reaches ${evidence.changedSource.slice(0, 3).join(', ')}, but this change also ` +
        `edits ${evidence.changedTests.length} test file(s). Coverage is followed through imports, which cannot see a test ` +
        'that reaches the code through a GraphQL resolver, an HTTP route or any other framework entry point - ' +
        'so whether those tests cover this is a question the imports cannot answer',
      decidedBy: 'imports followed through the source, which is a fact rather than a name match',
    });
  } else if (evidence.covering.length === 0) {
    checks.push({
      question: 'Is the changed code tested?',
      standing: 'not-met',
      answer: `no test imports or reaches ${evidence.changedSource.slice(0, 3).join(', ')}, and this change adds no test either, so nothing here could notice a mistake in it`,
      decidedBy: 'imports followed through the source, which is a fact rather than a name match',
    });
  } else {
    checks.push({
      question: 'Is the changed code tested?',
      standing: 'met',
      answer: `${evidence.covering.length} test file(s) reach it: ${evidence.covering.slice(0, 3).map((c) => c.testFile).join(', ')}`,
      decidedBy: 'imports followed through the source',
    });
  }

  // 3. Can the tests in this change fail at all? A test that cannot fail is worse than no test.
  if (evidence.changedTests.length === 0) {
    checks.push({ question: 'Can the tests in this change fail?', standing: 'not-applicable', answer: 'this change adds or edits no test', decidedBy: 'the diff' });
  } else if (evidence.cannotFail.length > 0) {
    checks.push({
      question: 'Can the tests in this change fail?',
      standing: 'not-met',
      answer: `${evidence.cannotFail.length} of them cannot: ${evidence.cannotFail.slice(0, 2).map((t) => `${t.name} (${t.file}:${t.line})`).join(', ')}`,
      decidedBy: 'tewip vouch, measured on 41,523 real tests in the six public projects in corpus/expected.json',
    });
  } else if (evidence.couldNotJudge > 0 && evidence.couldNotJudge >= evidence.changedTests.length) {
    // Nothing was established. `cannotFail` is empty because vouch declined every test in the
    // change, not because it found them sound - three tests that call the function under test and
    // assert nothing come back exactly like three good ones. Answering "yes" there is a clean
    // answer produced by looking at nothing, in the question that matters most on a change somebody
    // did not write by hand.
    checks.push({
      question: 'Can the tests in this change fail?',
      standing: 'not-checked',
      answer: `vouch would not judge any of the ${evidence.couldNotJudge} test(s) here: each body is one call to something it cannot follow, so whether they assert anything is unknown`,
      decidedBy: 'tewip vouch',
    });
  } else {
    checks.push({
      question: 'Can the tests in this change fail?',
      standing: 'met',
      answer: `every test in this change asserts something${evidence.crashOnly > 0 ? `, though ${evidence.crashOnly} compare no value and would only fail on a crash` : ''}`,
      decidedBy: 'tewip vouch',
    });
  }

  // 4. Would they catch a bug? The strongest check, and the one that costs the most, so often skipped.
  if (evidence.unnoticed === null) {
    checks.push({ question: 'Would the tests catch a bug in this code?', standing: 'not-checked', answer: 'not run: this means breaking the code on purpose and running the tests, which costs minutes. Ask for it with `--prove`.', decidedBy: 'tewip prove' });
  } else if (evidence.unnoticed.length > 0) {
    checks.push({
      question: 'Would the tests catch a bug in this code?',
      standing: 'not-met',
      answer: `${evidence.unnoticed.length} deliberate change(s) went unnoticed, including ${evidence.unnoticed[0].file}:${evidence.unnoticed[0].line} (${evidence.unnoticed[0].kind})`,
      decidedBy: 'tewip prove, by running the tests against a broken copy of the code',
    });
  } else {
    checks.push({ question: 'Would the tests catch a bug in this code?', standing: 'met', answer: 'every deliberate change made to this code was caught by a covering test', decidedBy: 'tewip prove' });
  }

  // 5. Does it keep the rules this team wrote down? Only a project that has written some can break them.
  if (evidence.brokenRules === null) {
    checks.push({ question: "Does it keep this project's own standards?", standing: 'not-checked', answer: 'this project has written none for Tewip to read, so there is nothing to keep or break', decidedBy: 'tewip standards' });
  } else if (evidence.brokenRules.length > 0) {
    const first = evidence.brokenRules[0];
    checks.push({
      question: "Does it keep this project's own standards?",
      standing: 'not-met',
      answer: `${evidence.brokenRules.length} rule(s) this team wrote are broken, starting with ${first.standard} at ${first.file}${first.line > 0 ? `:${first.line}` : ''}${first.why ? ` - ${first.why}` : ''}`,
      decidedBy: 'tewip standards, which enforces only the rules a pattern can check',
    });
  } else {
    checks.push({ question: "Does it keep this project's own standards?", standing: 'met', answer: 'every rule this team wrote and Tewip can check is kept', decidedBy: 'tewip standards' });
  }

  // 6. Is what was asked for covered? Only where the project keeps plans to compare against.
  if (evidence.uncovered === null) {
    checks.push({ question: 'Is what was asked for covered?', standing: 'not-checked', answer: 'this project keeps no test plan Tewip can read, so there is nothing to compare the change against', decidedBy: 'tewip trace' });
  } else if (evidence.uncovered.length > 0) {
    checks.push({
      question: 'Is what was asked for covered?',
      standing: 'not-met',
      answer: `${evidence.uncovered.length} scenario(s) related to this change have no test: ${evidence.uncovered.slice(0, 2).map((u) => `${u.id} ${u.title}`).join('; ')}`,
      decidedBy: 'tewip trace, which counts a scenario covered only when a real test can be named',
    });
  } else {
    checks.push({ question: 'Is what was asked for covered?', standing: 'met', answer: 'every scenario this change relates to has a test that can be named', decidedBy: 'tewip trace' });
  }

  const broken = checks.filter((c) => c.standing === 'not-met');
  const unknown = checks.filter((c) => c.standing === 'not-checked');
  // "Ready" requires that the two questions nothing can substitute for were actually answered: is
  // anything failing, and does anything test the changed code. Without those, "ready" would rest on
  // the checks that happened to be cheap - the first version said Ready on a project with no history
  // at all, which is an approval built out of three shrugs.
  const essential = checks.filter((c) => ESSENTIAL.includes(c.question));
  const verdict: Verdict = broken.length > 0 ? 'not-ready' : essential.some((c) => c.standing === 'not-checked') ? 'cannot-say' : 'ready';

  return {
    verdict,
    headline:
      broken.length > 0
        ? `Not ready: ${broken[0].answer}`
        : verdict === 'cannot-say'
          ? // Quoted, because the questions are questions: lowercasing them and joining with "and"
            // produced "is anything failing and is the changed code tested could not be checked",
            // which is the headline of the verdict this whole tool is named for.
            `Cannot say: ${
              essential.filter((c) => c.standing === 'not-checked').length === 1 ? 'one question that matters' : 'two questions that matter'
            } here went unanswered - ${essential
              .filter((c) => c.standing === 'not-checked')
              .map((c) => `"${c.question}"`)
              .join(' and ')} - so this is not an approval`
          : `Ready as far as ${checks.filter((c) => c.standing === 'met').length} check(s) can show${unknown.length > 0 ? `, with ${unknown.length} not checked` : ''}`,
    checks,
    notChecked: [
      ...unknown.map((c) => `${c.question.toLowerCase().replace(/\?$/, '')} - ${c.answer}`),
      'whether the change does what was intended, which no tool here can know',
      'the running application, its dependencies and its secrets, unless `tewip secure` was run separately',
    ],
  };
}

export function renderDecision(range: string, decision: Decision): string {
  const mark: Record<Standing, string> = { met: 'yes', 'not-met': '**no**', 'not-applicable': 'n/a', 'not-checked': 'not checked' };
  const title = decision.verdict === 'ready' ? 'Ready, as far as this can be shown' : decision.verdict === 'not-ready' ? 'Not ready' : 'Cannot say';
  const lines = [
    `# Is this work done? ${title}`,
    '',
    `For \`${range}\`. ${decision.headline}.`,
    '',
    '| Question | Answer |',
    '| --- | --- |',
    ...decision.checks.map((c) => `| ${c.question} | ${mark[c.standing]} |`),
    '',
  ];
  for (const check of decision.checks) {
    if (check.standing === 'not-applicable') continue;
    const said = `${mark[check.standing] === '**no**' ? 'No' : mark[check.standing] === 'yes' ? 'Yes' : 'Not checked'}: ${check.answer}`;
    lines.push(`### ${check.question}`, '', /[.!?]$/.test(said) ? said : `${said}.`, '', `_Decided by ${check.decidedBy}._`, '');
  }
  lines.push(
    '## What this says nothing about',
    '',
    ...decision.notChecked.map((n) => `- ${n}`),
    '',
    '---',
    '',
    'Nothing above is judged here: each answer comes from a layer with its own measured accuracy, and',
    'this only puts them in a fixed order - what is broken, then what cannot be believed, then what is',
    'missing. "Cannot say" is a real answer and is never rounded up to ready.',
  );
  return lines.join(String.fromCharCode(10));
}
