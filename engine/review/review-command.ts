// `tewip review --diff main...HEAD`: what a developer wants to know before anyone reads the diff.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changeSummary } from '../quality/grounding.ts';
import { chooseFramework, detectFrameworks } from '../quality/frameworks.ts';
import { readTriageRecords, datasetFiles } from '../../reporters/store.ts';
import type { TriageRecord } from '../../reporters/types.ts';
import { coverageFor, uncovered } from './coverage.ts';
import { renderReview, reviewChange, type Review } from './review.ts';
import { changedExpectations } from './expectations.ts';
import { changedAgreements } from './agreements.ts';

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
  const runCommand = framework && ownsThem ? (chosen: string[]) => chosen.map((f) => framework.command(resolve(cmd.root, f))).join(' && ') : undefined;

  const report = renderReview(review, runCommand);
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
