// `tewip done --diff main...HEAD`: gathering the evidence for the verdict.
//
// Every number here comes from a layer that already exists and has its own measured accuracy. This file
// only collects: what changed, what covers it, whether those tests can fail, whether they would catch a
// bug, what is failing now, and what a kept plan says is still uncovered. Where a layer has nothing to
// say, it is left as "not checked" rather than filled in with a guess.
import { describesThisProject, findCoverage, wasExecuted } from '../coverage/read-coverage.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { seal } from '../attest/seal.ts';
import { changedLinesByFile, proveChanged } from '../prove/changed.ts';
import { changeSummary } from '../quality/grounding.ts';
import { coverageFor, importsCanBeFollowed, testFiles } from '../review/coverage.ts';
import { importingTestsWithHow } from '../prove/covering.ts';
import { testsReaching } from '../prove/reaches.ts';
import { vouchChanged } from '../vouch/changed.ts';
import { languageOf, testsIn } from '../vouch/tests-in.ts';
import { checkChanged, loadStandards } from '../standards/standards-command.ts';
import { datasetFiles, readJsonl, readTriageRecords } from '../../reporters/store.ts';
import type { RunSummary, TriageRecord } from '../../reporters/types.ts';
import { decide, renderDecision, type Evidence } from './verdict.ts';

export interface DoneCommand {
  root: string;
  diff: string;
  /** Break the changed code and run the tests against it. Costs minutes; off unless asked. */
  prove?: boolean;
  proveBudgetSeconds?: number;
  out?: string;
  json?: string;
  /** Exit non-zero unless the verdict is "ready". */
  strict?: boolean;
  name?: string;
}

/**
 * Source, decided by the list that actually judges code rather than by a second one written here.
 *
 * This was a hand-rolled extension list, and it was missing `.rs`, `.scala`, `.groovy`, `.kts` and
 * `.fs` - all five of which `languageOf` has known for months and `tewip vouch` reads every day.
 * A file the list did not name was not source, and a change containing no source makes "Is the
 * changed code tested?" **not applicable**.
 *
 * On ripgrep's `--max-bytes` commit - four `.rs` files edited, three `.rs` test files added - the
 * report said "Can the tests in this change fail? **yes: every test in this change asserts
 * something**", having read all three Rust test files, and two rows above it said the question of
 * whether the changed code is tested **does not apply**. One report, reading the tests of a change
 * it had just called sourceless. `n/a` is the strongest of the wrong answers available: it does not
 * say "unknown", it says the question is not worth asking. Phase 217.
 */
const isSource = (file: string): boolean => languageOf(file) !== null;
const IS_TEST = /(^|[\\/])(tests?|spec|specs|__tests__|e2e)[\\/]|[._-](test|tests|spec|specs)\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs)$/i;

/** Every failure Tewip has kept for this project, and every run. */
function history(root: string, only?: string): { runs: RunSummary[]; records: TriageRecord[] } {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return { runs: [], records: [] };
  const runs: RunSummary[] = [];
  const records: TriageRecord[] = [];
  for (const project of only ? [only] : readdirSync(dir)) {
    const where = join(dir, project);
    if (!existsSync(where)) continue;
    runs.push(...readJsonl<RunSummary>(datasetFiles(where).runs));
    records.push(...readTriageRecords(datasetFiles(where).triage));
  }
  runs.sort((a, b) => (a.finishedAt > b.finishedAt ? 1 : -1));
  return { runs, records };
}

/** Scenarios of kept plans that this change relates to and nothing covers. Null when no plans exist. */
/**
 * Scenarios this change touches that no test covers, and what stopped the question being answered.
 *
 * The gaps alone cannot carry it. An empty list means one of three different things: every scenario
 * is covered, no plan here is about this change, or every plan failed to parse and was silently
 * skipped - and the gate read all three as "every scenario this change relates to has a test".
 * Measured on a project with one plan file containing the word "refunds" and no valid JSON.
 */
function uncoveredFor(root: string, changed: string[], attempted: string[]): { gaps: Evidence['uncovered']; unreadable: number; considered: number } {
  const dir = join(root, '.tewip', 'plans');
  if (!existsSync(dir)) return { gaps: null, unreadable: 0, considered: 0 };
  const words = new Set(changed.flatMap((f) => (f.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])));
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out: Array<{ id: string; title: string }> = [];
  let unreadable = 0;
  let considered = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const saved = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { plan?: { title?: string; scenarios?: Array<Record<string, string>> }; feature?: string };
      const plan = saved.plan ?? (saved as never);
      if (!Array.isArray(plan.scenarios)) continue;
      // Only plans this change has something to do with: a verdict about an unrelated feature's gaps
      // would block every pull request in the project forever.
      const about = (`${plan.title ?? ''} ${saved.feature ?? ''}`.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).some((w) => words.has(w));
      if (!about) continue;
      considered += 1;
      for (const scenario of plan.scenarios) {
        const covered = (scenario.covered_by ?? '').trim() || attempted.find((t) => clean(t).includes(clean(scenario.id)) && clean(scenario.id).length >= 4);
        if (!covered) out.push({ id: scenario.id, title: scenario.title });
      }
    } catch {
        // Skipped in silence until Phase 112: an unparseable plan left the gap list empty,
        // which the gate read as full coverage.
        unreadable += 1;
    }
  }
  return { gaps: out, unreadable, considered };
}

export function gather(cmd: DoneCommand): { evidence: Evidence; changed: string[] } | null {
  const change = changeSummary(cmd.root, cmd.diff);
  if (!change || change.files.length === 0) return null;
  const changed = change.files.map((f) => f.split('\\').join('/'));
  const changedSource = changed.filter((f) => isSource(f) && !IS_TEST.test(f) && existsSync(resolve(cmd.root, f)));
  // In a test folder is not the same as being a test. `IS_TEST` matches a path, and a path says
  // nothing about what is in the file: keycloak's change was two `migration-realm-1.9.8.Final-
  // Migration.json` resources under `tests/base/src/test/resources/`, immich's included the
  // generated `open-api/immich-openapi-specs.json`, and the report answered "Can the tests in this
  // change fail? **Yes: every test in this change asserts something**" about a change containing
  // no tests at all - a `met` row, counted towards the verdict. A file in a language Tewip cannot
  // read tests in is not a test. Phase 217.
  const changedTests = changed.filter((f) => IS_TEST.test(f) && languageOf(f) !== null && existsSync(resolve(cmd.root, f)));

  const known = testFiles(cmd.root);
    // A coverage report the project already produces, if there is one. Imports cannot see a test that
  // posts a GraphQL query, hits an HTTP route or renders a controller - and Phases 46 and 52 both
  // ended at "cannot say" on every real Saleor pull request because of it. A coverage report records
  // what ran, so it answers the question imports could not.
  const report = findCoverage(cmd.root);
  const coverage =
    report && describesThisProject(report, cmd.root)
      ? {
          from: report.from,
          executed: changedSource.filter((f) => wasExecuted(report, f)),
          notExecuted: changedSource.filter((f) => report.mentioned.has(f.split('\\').join('/')) && !wasExecuted(report, f)),
        }
      : undefined;

  const covering: Evidence['covering'] = [];
  for (const file of changedSource) {
    // Said as it was found. A `package` match is a test importing the front door of the folder the
    // changed file sits in - real, and not the same claim as naming the file. All eight tests
    // angular-components listed for `datepicker-input-base.ts` were package matches, and the
    // report called every one of them "imports it".
    const direct = importingTestsWithHow(cmd.root, coverageFor(cmd.root, [file], known), file);
    for (const test of direct)
      if (!covering.some((c) => c.testFile === test.testFile))
        covering.push({ testFile: test.testFile, how: test.how === 'package' ? 'imports the package it is in' : 'imports it' });
    if (direct.length > 0) continue;
    for (const reach of testsReaching(cmd.root, file, known.map((t) => t.split('\\').join('/')))) {
      if (!covering.some((c) => c.testFile === reach.testFile)) covering.push({ testFile: reach.testFile, how: `reaches it through ${reach.steps} import(s)` });
    }
  }

  // Tests that live in the changed file itself, which no import graph can reach.
  const selfTested = changedSource.filter((file) => {
    const language = languageOf(file);
    if (!language) return false;
    try {
      return testsIn(language, readFileSync(resolve(cmd.root, file), 'utf8')).length > 0;
    } catch {
      return false;
    }
  });

  const importsNotFollowed = changedSource.filter((f) => !importsCanBeFollowed(f));

  const vouched = vouchChanged(cmd.root, changedTests);
  const { runs, records } = history(cmd.root, cmd.name);
  const newest = runs.at(-1);
  const touched = new Set([...changedSource, ...changedTests, ...covering.map((c) => c.testFile)]);
  const failingNow = records
    .filter((r) => r.runId === newest?.runId)
    .filter((r) => {
      const where = String((r as { file?: string }).file ?? '').split('\\').join('/');
      return touched.has(where) || [...touched].some((t) => r.testId.includes(t.replace(/\.[a-z]+$/, '')));
    })
    .map((r) => ({ testId: r.testId, category: String((r.diagnosis as { category?: string } | undefined)?.category ?? 'UNKNOWN') }));

  const standards = loadStandards(cmd.root);
  const plans = uncoveredFor(cmd.root, changed, Object.keys(newest?.attempts ?? {}));
  const brokenRules = standards.length === 0 ? null : checkChanged(cmd.root, standards, changed).map((v) => ({ standard: v.standard, file: v.file, line: v.line, why: v.rule.because }));

  const proved = cmd.prove
    ? proveChanged(cmd.root, changedSource, {
        budgetSeconds: cmd.proveBudgetSeconds ?? 300,
        // The same range the file list came from, so the lines mutated are the lines this change wrote.
        lines: changedLinesByFile(cmd.root, change.range),
        onStep: (m) => console.error(`  ${m}`),
      })
    : null;

  return {
    changed,
    evidence: {
      changedSource,
      changedTests,
      covering,
      selfTested,
      importsNotFollowed,
    coverage,
      cannotFail: vouched.cannotFail.map((j) => ({ name: j.name, file: j.file, line: j.line, why: j.why })),
      crashOnly: vouched.crashOnly.length,
      couldNotJudge: vouched.couldNotJudge.length,
      proofsTried: proved ? proved.proofs.reduce((n, pr) => n + pr.tried.length, 0) : 0,
      proofSkipped: proved?.skipped ?? '',
      unnoticed: proved ? proved.proofs.flatMap((p) => p.tried.filter((t) => t.fate === 'unnoticed').map((t) => ({ file: p.file, line: t.mutant.line, kind: t.mutant.kind }))) : null,
      failingNow,
      noHistory: runs.length === 0,
      uncovered: plans.gaps,
      plansUnreadable: plans.unreadable,
      plansConsidered: plans.considered,
      brokenRules,
    },
  };
}

export function runDone(cmd: DoneCommand): { verdict: string } {
  const gathered = gather(cmd);
  if (!gathered) throw new Error(`nothing changed in "${cmd.diff}", or that range could not be read. Is this a git checkout? (try --diff main...HEAD)`);

  const decision = decide(gathered.evidence);
  const report = renderDecision(cmd.diff, decision);
  console.log(report);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), report + String.fromCharCode(10), 'utf8');
  }
  if (cmd.json) {
    // Sealed, so a verdict that travels - into a ticket, a release note, an audit - can be checked
    // rather than trusted. The digest is of the content; a signature needs TEWIP_ATTEST_KEY.
    const bundle = { range: cmd.diff, changed: gathered.changed, ...decision };
    const sealed = { ...bundle, seal: seal(bundle as never, process.env.TEWIP_ATTEST_KEY?.includes('BEGIN') ? process.env.TEWIP_ATTEST_KEY : undefined) };
    mkdirSync(dirname(resolve(cmd.json)), { recursive: true });
    writeFileSync(resolve(cmd.json), JSON.stringify(sealed, null, 2), 'utf8');
  }
  if (cmd.strict && decision.verdict !== 'ready') {
    console.error(String.fromCharCode(10) + decision.headline);
    process.exitCode = 1;
  }
  return { verdict: decision.verdict };
}
