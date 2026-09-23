// The specification as a person reads it: an epic, its stories, their acceptance criteria, what is
// already true with the quote that shows it, and the questions only a person can answer.
import type { Spec, Story } from './spec.ts';

/**
 * Models often write the keyword into the field: "Given the library has books". The renderer adds
 * it too, and "Given Given the library has books" reads like a machine wrote it, which is exactly
 * the impression a specification must not give.
 */
const KEYWORD = /^(?:given|when|then)\s+/i;
const said = (text: string): string => text.trim().replace(KEYWORD, '').replace(/[.;]$/, '');

/** One story, written the way it goes into a ticket. */
export function storyBody(story: Story): string {
  return [
    story.title,
    '',
    story.why ? `Why: ${story.why}` : '',
    `Priority: ${story.priority}`,
    story.today ? `\nToday: ${story.today}\nSeen in: ${story.evidence}` : '',
    '',
    'Acceptance criteria:',
    ...story.acceptance_criteria.flatMap((c) => [`${c.id}`, `  Given ${said(c.given)}`, `  When ${said(c.when)}`, `  Then ${said(c.then)}`]),
    '',
    'Written by Tewip from the code and tests in this project; review before you rely on it.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function renderSpec(spec: Spec): string {
  const lines: string[] = [`# ${spec.epic.title}`, '', spec.epic.summary, ''];
  if (spec.epic.problem) lines.push(`**The problem.** ${spec.epic.problem}`, '');
  if (spec.epic.value) lines.push(`**Why it is worth doing.** ${spec.epic.value}`, '');
  if (spec.epic.out_of_scope.length > 0) {
    lines.push('**Not in this epic**', '');
    for (const item of spec.epic.out_of_scope) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push(`## Stories (${spec.stories.length})`, '');
  for (const story of spec.stories) {
    lines.push(`### ${story.id} · ${story.title}`, '');
    if (story.why) lines.push(story.why, '');
    lines.push(`Priority: ${story.priority}`, '');
    if (story.today) lines.push(`Today: ${story.today}  `, `Seen in: \`${story.evidence}\``, '');
    for (const c of story.acceptance_criteria) {
      lines.push(`- **${c.id}** Given ${said(c.given)}; when ${said(c.when)}; then ${said(c.then)}.`);
    }
    lines.push('');
  }

  if (spec.already_true.length > 0) {
    lines.push('## What the code already does', '', 'Each line is quoted from a file Tewip read; anything it could not quote is an open question instead.', '');
    for (const claim of spec.already_true) lines.push(`- ${claim.claim}  \n  \`${claim.evidence}\``);
    lines.push('');
  }

  if (spec.open_questions.length > 0) {
    lines.push('## Open questions', '');
    for (const question of spec.open_questions) lines.push(`- ${question}`);
    lines.push('');
  }

  lines.push('---', '', 'Written by Tewip from this project\'s code, tests and failure history. It contains no estimates,');
  lines.push('dates or business claims: those cannot be checked against anything here.');
  return lines.join('\n');
}
