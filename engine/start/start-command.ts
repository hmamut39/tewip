// What to run here, and what Tewip will not answer - the words, given the look.
//
// Split from the look itself when adding the evidence pack to the front door pushed this past the
// 300 lines this project allows. `look.ts` counts what is in the directory; this decides what to
// say about it. The same split as cli/verbs-assure.ts beside cli/tewip.ts.
import { resolve } from 'node:path';
import { lookAround, named, PLAIN, total, type Found, type Suggestion } from './look.ts';

/** The two or three things worth running here, most useful first. */
export function suggest(found: Found): Suggestion[] {
  const out: Suggestion[] = [];
  const tests = total(found.tests);
  const migrations = total(found.migrations);
  const manifests = total(found.manifests);

  // The evidence pack first, when there is anything for it to read.
  //
  // It did not exist when this front door was written, and it is the only command that answers a
  // whole question rather than a part of one: what ships, what a model and the infrastructure may
  // do, what breaks if it ships, who approved it, and how much each answer is worth. For the
  // person who has to sign something that is the first useful answer, and `--quick` gets it in
  // seconds by leaving out the three whole-repository walks - which the document then names as
  // skipped, so nobody mistakes a fast pack for a complete one.
  if (manifests > 0 || found.containers > 0) {
    const has = [
      manifests > 0 ? `${manifests} dependency ${manifests === 1 ? 'manifest' : 'manifests'} (${named(found.manifests)})` : '',
      found.containers > 0 ? `${found.containers} ${found.containers === 1 ? 'Dockerfile' : 'Dockerfiles'}` : '',
    ].filter(Boolean);
    out.push({
      command: 'tewip evidence --quick',
      because:
        `${found.stoppedEarly ? 'At least ' : ''}${has.join(' and ')} here. One signed document: what ships and under which licence, ` +
        'what a model and the infrastructure are allowed to do, what breaks if it ships, and who approved it - each line carrying the ' +
        'precision and recall that check scored against a published list. Drop `--quick` for the whole thing.',
    });
  }

  if (tests > 0) {
    out.push({
      command: 'tewip vouch',
      because: `${found.stoppedEarly ? 'At least ' : ''}${tests} test ${tests === 1 ? 'file' : 'files'} here (${named(found.tests)}). This reads them and names the ones that cannot fail - no model, a second or two.`,
    });
  }
  if (migrations > 0) {
    out.push({
      command: 'tewip schema --diff main...HEAD',
      because: `${found.stoppedEarly ? 'At least ' : ''}${migrations} ${migrations === 1 ? 'migration' : 'migrations'} here (${named(found.migrations)}). This says what a change would do to a live database before it runs.`,
    });
  }
  if (found.markup > 0) {
    out.push({
      command: 'tewip access',
      because: `${found.stoppedEarly ? 'At least ' : ''}${found.markup} markup ${found.markup === 1 ? 'file' : 'files'} here. This names who cannot use the interface, against the WCAG criterion a regulator would cite.`,
    });
  }
  for (const report of found.perfReports.slice(0, 1)) {
    out.push({
      command: `tewip perf ${report}`,
      because: 'there is already a performance report here, and Tewip will judge it rather than restate it.',
    });
  }
  if (tests > 0) {
    out.push({
      command: 'tewip done',
      because: 'the one verdict over your current change, once you have made one. It answers ready, not ready, or cannot say.',
    });
  }
  return out;
}

export function renderStart(found: Found, root: string): string {
  const lines = ['# Tewip', ''];

  if (!found.filesSeen) {
    lines.push(`There is nothing to read in \`${root}\`. Run Tewip from the root of a project.`, '');
    return lines.join('\n');
  }

  const suggestions = suggest(found);
  if (suggestions.length === 0) {
    lines.push(
      `Tewip looked around \`${root}\` and found nothing it can judge: no test files, no migrations, no markup, ` +
        'and no performance report. That is an honest answer rather than a failure - point it at a project with ' +
        'tests in it, or run `tewip --help` for the full list.',
      '',
    );
    return lines.join('\n');
  }

  lines.push('Here is what Tewip can tell you about **this** project, in the order worth doing.', '');
  for (const [i, s] of suggestions.entries()) {
    lines.push(`**${i + 1}. \`${s.command}\`**`, '', s.because, '');
  }

  lines.push('## What it will not do here', '');
  const cannot: string[] = [];
  if (found.stoppedEarly) {
    cannot.push(
      'This project is larger than Tewip looks at from here, so the counts above are **at least** ' +
        'that many rather than exactly. The commands themselves read everything; only this first ' +
        'glance is bounded, so that it stays instant.',
    );
  }
  if (total(found.tests) === 0) cannot.push('No test files were found, so nothing can be said about whether your tests could fail or would catch a bug.');
  if (total(found.migrations) === 0) cannot.push('No migrations were found, so nothing is said about your database.');
  if (found.markup === 0) cannot.push('No markup was found, so nothing is said about accessibility.');
  if (found.perfReports.length === 0) cannot.push('No k6, JMeter or Lighthouse report was found. Tewip judges one you produce; it does not run load tests itself.');
  if (!found.hasStandards) cannot.push('This project has not taught Tewip any house rules yet. Put a markdown file in `.tewip/standards/` and `tewip standards` will enforce it.');
  if (!found.hasWorkflows) cannot.push('There is no GitHub Actions workflow here. `uses: hmamut39/tewip@main` with `mode: check` runs these same checks on every pull request.');
  else cannot.push('You have GitHub Actions. `mode: check` runs these same checks on every pull request.');
  for (const line of cannot) lines.push(`- ${line}`);
  lines.push('');

  lines.push(
    'Everything Tewip answers carries its evidence and says what it did **not** check. It answers ' +
      // No count here, deliberately. This said "all eleven commands" from the day it was written,
      // and the command line dispatches forty-one: the front door understated the tool nearly
      // fourfold because a number was written into prose and nothing ever re-derived it. A claim
      // that cannot be checked does not belong in the first thing a new user reads.
      '"cannot say" rather than guessing. `tewip --help` lists every command when you want them.',
    '',
  );
  return lines.join('\n');
}

export function runStart(root: string): string {
  const where = resolve(root);
  const report = renderStart(lookAround(where), where);
  console.log(report);
  return report;
}
