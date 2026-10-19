// `tewip review --diff main...HEAD`: what a developer wants to know before anyone reads the diff.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changeSummary } from '../quality/grounding.ts';
import { chooseFramework, detectFrameworks } from '../quality/frameworks.ts';
import { readTriageRecords, datasetFiles } from '../../reporters/store.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { coverageFor, uncovered } from './coverage.ts';
import { renderReview, reviewChange, runFrom, type Review } from './review.ts';
import { changedExpectations } from './expectations.ts';
import { changedAgreements } from './agreements.ts';
import { changedTestLines, vouchChanged } from '../vouch/changed.ts';
import { checkChanged, loadStandards } from '../standards/standards-command.ts';
import { renderViolations } from '../standards/standards.ts';

export interface ReviewCommand {
  root: string;
  /** A git range: "main...HEAD" by default. */
  diff: string;
  out?: string;
  /** Only this kept project's history. */
  name?: string;
}

/** Every failure Tewip has diagnosed in this project, from the history it keeps. */
function history(root: string, only?: string): TriageRecord[] {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return [];
  const names = only ? [only] : readdirSync(dir);
  return names.flatMap((name) => readTriageRecords(datasetFiles(join(dir, name)).triage));
}

export async function runReview(cmd: ReviewCommand): Promise<Review | null> {
  const change = changeSummary(cmd.root, cmd.diff);
  if (!change) throw new Error(`could not read the change "${cmd.diff}". Is this a git checkout, and does that range exist? (try --diff main...HEAD)`);
  if (change.files.length === 0) {
    console.log(`Nothing changed in ${cmd.diff}.`);
    return null;
  }

  const files = change.files.map((f) => f.split('\\').join('/'));
  const coverage = coverageFor(cmd.root, files);
  const past = history(cmd.root, cmd.name);
  const review = reviewChange(cmd.diff, files, coverage, past, uncovered(files, coverage), changedExpectations(cmd.root, cmd.diff), changedAgreements(cmd.root, cmd.diff));

  // The command that runs just those tests - but only when the project's runner really owns them.
  // Printing a Playwright command for a file Playwright never runs is worse than printing nothing.
  const framework = chooseFramework(detectFrameworks(cmd.root), undefined, false) ?? detectFrameworks(cmd.root)[0] ?? null;
  const ownsThem = framework ? review.runFirst.some((f) => resolve(cmd.root, f).startsWith(resolve(framework.testDir))) : false;
  // And from the directory the runner actually runs in. `framework.command` builds paths relative
  // to the framework's own cwd, which in a layered project is not where the report is read: this
  // printed `node --test "test/flaky.test.ts"` for a file at engine/test/flaky.test.ts, and copying
  // it gave "Could not find 'test/flaky.test.ts'". The one actionable line in a review has to work
  // where somebody pastes it.
  const prefix = framework ? runFrom(cmd.root, framework.cwd) : '';
  const runCommand =
    framework && ownsThem ? (chosen: string[]) => prefix + chosen.map((f) => framework.command(resolve(cmd.root, f))).join(' && ') : undefined;

  // Whether the tests in this change could ever fail. Costs nothing, calls no model, and is the one
  // question an agent-written diff most needs asked of it.
  const vouched = changedTestLines(vouchChanged(cmd.root, files));
  // The project's own rules, which Tewip only knows because this team wrote them down.
  const standards = loadStandards(cmd.root);
  const broken = renderViolations(checkChanged(cmd.root, standards, files), standards);
  const report = [renderReview(review, runCommand), ...(vouched.length > 0 ? ['', ...vouched] : []), ...(broken.length > 0 ? ['', ...broken] : [])].join(String.fromCharCode(10));
  console.log(report);
  if (past.length === 0) {
    console.log('\nNo failure history yet, so the "what has gone wrong here before" part is empty. It fills itself: run `tewip explain` or `tewip report` on your CI reports and every later review knows more.');
  }
  if (cmd.out) {
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
    console.log(`\nWritten to ${cmd.out}`);
  }
  return review;
}
