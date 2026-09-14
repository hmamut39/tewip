// Release-readiness report for UAT / business users: is the product broken, in plain words.
// Only confident product problems block; everything else is explained as "not the product".
import { ESCALATE_BELOW } from '../../engine/decide.ts';
import type { TriageItem } from '../items.ts';
import { clean, itemBlock, PLAIN_CATEGORY, sourceNote, type View } from '../view.ts';

export function releaseView(items: TriageItem[], runId: string, dataset: string): View {
  const blockers = items.filter((i) => i.diagnosis.category === 'REAL_BUG' && i.diagnosis.confidence >= ESCALATE_BELOW);
  const review = items.filter((i) => (i.diagnosis.category === 'REAL_BUG' && i.diagnosis.confidence < ESCALATE_BELOW) || i.diagnosis.category === 'UNKNOWN');
  const fine = items.filter((i) => !blockers.includes(i) && !review.includes(i));
  const areas = [...new Set(blockers.map((i) => i.component))];

  const verdict =
    blockers.length > 0
      ? `**NOT READY**: ${blockers.length} product problem(s) found, in ${areas.map((a) => `"${a}"`).join(', ')}.`
      : review.length > 0
        ? `**WAIT**: no confirmed product problem, but ${review.length} failure(s) are still being looked at.`
        : `**READY from a product point of view**: none of the ${items.length} failing test(s) is a product problem.`;

  const plain = (i: TriageItem) =>
    review.includes(i)
      ? `In plain words: not understood yet; someone is checking whether "${clean(i.title)}" is a product problem.`
      : i.diagnosis.category === 'REAL_BUG'
        ? `In plain words: in the "${i.component}" area, "${clean(i.title)}" did not work as expected.`
        : `In plain words: ${PLAIN_CATEGORY[i.diagnosis.category]}, not a problem in the product itself.`;

  const section = (title: string, xs: TriageItem[]) => (xs.length === 0 ? [] : [`## ${title} (${xs.length})`, '', ...xs.map((i) => itemBlock(i, [plain(i)])), '']);

  const markdown = [
    `# Release readiness: run ${runId}`,
    '',
    verdict,
    '',
    sourceNote(dataset),
    '',
    ...section('Product problems (block the release)', blockers),
    ...section('Still being looked at', review),
    ...section('Not product problems (do not block)', fine),
  ].join('\n');

  return { id: 'release', role: 'business', title: `Release readiness for run ${runId}`, scope: 'run', items, markdown };
}
