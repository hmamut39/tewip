// `tewip safety`: the page to hand someone who has to approve an agent touching the codebase.
//
// Two halves, and the second is the one that makes the first worth reading. The promises, each
// naming the test that enforces it. Then what Tewip refused in this project's own kept history -
// real refusals, counted, not a claim that it refuses things in general.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { datasetFiles, readTriageRecords } from '../../reporters/store.ts';
import { checkPromises, type Checked } from './safety.ts';

export interface SafetyCommand {
  root: string;
  out?: string;
}

/**
 * Refusals Tewip actually made here: failures it read, decided about, and declined to name a
 * cause for.
 *
 * `decided` is not the same as `kept`, and conflating them produced a false statistic in the
 * first version of this page - "Tewip declined to put a cause on 1305 of 1305 failures (100.0%)",
 * which reads as a tool that explains nothing. The collection path stores the raw failure and
 * nothing else; a category is worked out when a report is rendered. So a record with no diagnosis
 * has not been refused, it has not been read, and counting the two together turned "nobody has
 * run a report over this history" into a claim about Tewip's judgement. The same mistake Phase 59
 * found in `recall`, made again in the one document where a false number does most damage.
 */
function refusedHere(root: string): { kept: number; decided: number; undecided: number } {
  const dir = join(root, '.tewip', 'history');
  if (!existsSync(dir)) return { kept: 0, decided: 0, undecided: 0 };
  let kept = 0;
  let decided = 0;
  let undecided = 0;
  for (const project of readdirSync(dir)) {
    const where = join(dir, project);
    for (const record of readTriageRecords(datasetFiles(where).triage)) {
      kept += 1;
      const category = (record.diagnosis as { category?: string } | undefined)?.category;
      if (!category) continue; // never diagnosed, so never refused
      decided += 1;
      if (category === 'UNKNOWN') undecided += 1;
    }
  }
  return { kept, decided, undecided };
}

export function renderSafety(checked: Checked[], refused: { kept: number; decided: number; undecided: number }): string {
  const broken = checked.filter((c) => !c.enforced);
  const lines = [
    '# What Tewip may do here, and what it will not',
    '',
    'Every line below names the test that enforces it. This page is written by reading those tests',
    'off disk: a promise whose test has been deleted or renamed is printed as no longer enforced,',
    'not quietly dropped. If that happens, this page will say so before you have to find out.',
    '',
    `## ${checked.length - broken.length} of ${checked.length} promises are enforced by a test right now`,
    '',
  ];
  for (const c of checked) {
    lines.push(`- ${c.enforced ? '**Enforced.**' : '**NO LONGER ENFORCED.**'} ${c.claim}`);
    lines.push(`  - Why it matters: ${c.because}`);
    lines.push(
      c.enforced
        ? `  - Checked by \`${c.file}\` → *${c.test}*`
        : `  - **The test that enforced this is gone.** It was \`${c.file}\` → *${c.test}*. Treat the promise above as unsupported until it is back.`,
    );
  }
  lines.push('');

  if (broken.length > 0) {
    lines.push(`**${broken.length} promise(s) on this page are not currently enforced.** That is the page doing its job, and it is also a problem to fix.`, '');
  }

  lines.push('## What it refused in this project', '');
  if (refused.kept === 0) {
    lines.push('Nothing is kept here yet, so Tewip has refused nothing here. This section fills in once it has read some runs: it counts real refusals, rather than promising that it makes them.', '');
  } else if (refused.decided === 0) {
    lines.push(
      `${refused.kept} failure(s) are kept here and none of them carries a decision, so there is nothing to count yet.`,
      '',
      'Storing a failure and judging one are separate steps here - a report has not been run over',
      'this history. Counting the undecided ones as refusals would say Tewip declined to explain',
      `all ${refused.kept}, which would be this page's own worst mistake: a number that flatters by`,
      'being wrong in the direction that sounds humble.',
      '',
    );
  } else {
    const share = ((refused.undecided / refused.decided) * 100).toFixed(1);
    lines.push(
      `Of ${refused.decided} failure(s) Tewip has judged here, it declined to name a cause for ${refused.undecided} (${share}%).`,
      refused.kept > refused.decided ? `(${refused.kept - refused.decided} more are stored but not yet judged, and are not counted either way.)` : '',
      '',
      'That number is meant to be above zero. A tool that explains every failure it is shown is',
      'guessing at some of them, and a guess is indistinguishable from an answer once it is written down.',
      '',
    );
  }

  lines.push(
    '## What this page does not cover',
    '',
    '- It lists what is tested, not everything Tewip does. An absence here is not a promise.',
    '- `tewip fix --code` edits application code rather than tests. It is off unless you ask for it, and the promises above apply to it, but it is the one command that changes code you did not point at.',
    '- Nothing here is a security audit of Tewip itself.',
    '',
  );
  return lines.join('\n');
}

export function runSafety(cmd: SafetyCommand): string {
  const report = renderSafety(checkPromises(cmd.root), refusedHere(cmd.root));
  console.log(report);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
    console.error(`\nWritten to ${cmd.out}`);
  }
  return report;
}
