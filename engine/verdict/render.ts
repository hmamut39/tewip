// The report `tewip done` prints, split from the deciding when verdict.ts passed this project's
// 300-line rule.
//
// Nothing here decides anything. It renders what `decide` returned, and the one rule it has to keep
// is that the table says what the checks say: every question is phrased so a yes is good news,
// because the standing is rendered as yes or no and a reviewer reads the table before the detail.
import type { Check, Decision, Standing } from './verdict.ts';

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
