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
import { proveChanged } from '../prove/changed.ts';
import { changeSummary } from '../quality/grounding.ts';
import { coverageFor, testFiles } from '../review/coverage.ts';
import { importingTests } from '../prove/prove.ts';
import { testsReaching } from '../prove/reaches.ts';
import { vouchChanged } from '../vouch/changed.ts';
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

const SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|java|kt|go|cs|rb|php)$/i;
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
function uncoveredFor(root: string, changed: string[], attempted: string[]): Evidence['uncovered'] {
  const dir = join(root, '.tewip', 'plans');
  if (!existsSync(dir)) return null;
  const words = new Set(changed.flatMap((f) => (f.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])));
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out: Array<{ id: string; title: string }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const saved = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { plan?: { title?: string; scenarios?: Array<Record<string, string>> }; feature?: string };
      const plan = saved.plan ?? (saved as never);
      if (!Array.isArray(plan.scenarios)) continue;
      // Only plans this change has something to do with: a verdict about an unrelated feature's gaps
      // would block every pull request in the project forever.
      const about = (`${plan.title ?? ''} ${saved.feature ?? ''}`.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).some((w) => words.has(w));
      if (!about) continue;
      for (const scenario of plan.scenarios) {
        const covered = (scenario.covered_by ?? '').trim() || attempted.find((t) => clean(t).includes(clean(scenario.id)) && clean(scenario.id).length >= 4);
        if (!covered) out.push({ id: scenario.id, title: scenario.title });
      }
    } catch {
      // Not a readable plan.
    }
  }
  return out;
}

export function gather(cmd: DoneCommand): { evidence: Evidence; changed: string[] } | null {
  const change = changeSummary(cmd.root, cmd.diff);
  if (!change || change.files.length === 0) return null;
  const changed = change.files.map((f) => f.split('\\').join('/'));
  const changedSource = changed.filter((f) => SOURCE.test(f) && !IS_TEST.test(f) && existsSync(resolve(cmd.root, f)));
  const changedTests = changed.filter((f) => IS_TEST.test(f) && existsSync(resolve(cmd.root, f)));

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
    const direct = importingTests(cmd.root, coverageFor(cmd.root, [file], known), file);
    for (const test of direct) if (!covering.some((c) => c.testFile === test)) covering.push({ testFile: test, how: 'imports it' });
    if (direct.length > 0) continue;
    for (const reach of testsReaching(cmd.root, file, known.map((t) => t.split('\\').join('/')))) {
      if (!covering.some((c) => c.testFile === reach.testFile)) covering.push({ testFile: reach.testFile, how: `reaches it through ${reach.steps} import(s)` });
    }
  }

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
  const brokenRules = standards.length === 0 ? null : checkChanged(cmd.root, standards, changed).map((v) => ({ standard: v.standard, file: v.file, line: v.line, why: v.rule.because }));

  const proved = cmd.prove ? proveChanged(cmd.root, changedSource, { budgetSeconds: cmd.proveBudgetSeconds ?? 300, onStep: (m) => console.error(`  ${m}`) }) : null;

  return {
    changed,
    evidence: {
      changedSource,
      changedTests,
      covering,
    coverage,
      cannotFail: vouched.cannotFail.map((j) => ({ name: j.name, file: j.file, line: j.line, why: j.why })),
      crashOnly: vouched.crashOnly.length,
      couldNotJudge: vouched.couldNotJudge.length,
      proofsTried: proved ? proved.proofs.reduce((n, pr) => n + pr.tried.length, 0) : 0,
      proofSkipped: proved?.skipped ?? '',
      unnoticed: proved ? proved.proofs.flatMap((p) => p.tried.filter((t) => t.fate === 'unnoticed').map((t) => ({ file: p.file, line: t.mutant.line, kind: t.mutant.kind }))) : null,
      failingNow,
      noHistory: runs.length === 0,
      uncovered: uncoveredFor(cmd.root, changed, Object.keys(newest?.attempts ?? {})),
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
