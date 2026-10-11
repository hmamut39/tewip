// Phase 28-32: writing the accessibility report.
//
// Split out of access-command.ts to keep every file in this project under 300 lines, which the
// Lighthouse reader pushed it past. The rendering is the part most worth keeping readable: it is
// where the distinction between a barrier, a question and a piece of advice is actually made
// visible to a person, and where what was *not* checked gets said.

import type { AccessResult } from './access-command.ts';
import type { Finding } from './checks.ts';
import { nowChecked, renderBrowserSection, stillNotChecked } from './merge.ts';
import { blocks, criterionOf, RULES, type Severity } from './wcag.ts';

const ORDER: Record<Severity, number> = { blocker: 0, serious: 1, moderate: 2, minor: 3 };

export function worstFirst(a: Finding, b: Finding): number {
  const sa = ORDER[RULES[a.rule]?.severity ?? 'minor'];
  const sb = ORDER[RULES[b.rule]?.severity ?? 'minor'];
  if (sa !== sb) return sa - sb;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

function group(findings: Finding[]): Map<string, Finding[]> {
  const by = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = by.get(f.rule);
    if (list) list.push(f);
    else by.set(f.rule, [f]);
  }
  return by;
}

function section(title: string, findings: Finding[], lines: string[]): void {
  if (findings.length === 0) return;
  lines.push(`## ${title}`, '');
  for (const [rule, found] of group(findings)) {
    const meta = RULES[rule];
    lines.push(`### ${rule} - ${found.length} ${found.length === 1 ? 'place' : 'places'}`, '');
    lines.push(`${criterionOf(rule)}, ${meta?.severity ?? 'unrated'}.`, '');
    if (meta) lines.push(`Who it stops: ${meta.stops}.`, '');
    for (const f of found.slice(0, 20)) {
      lines.push(`- \`${f.file}:${f.line}\`  ${f.element}`);
      lines.push(`  - ${f.why}`);
      lines.push(`  - do this: ${f.next}`);
    }
    if (found.length > 20) lines.push(`- ...and ${found.length - 20} more of the same, in the JSON beside this report.`);
    lines.push('');
  }
}

export function renderAccess(result: Omit<AccessResult, 'report'>, scanned: string): string {
  const { barriers, questions, accepted, filesRead, browser } = result;
  const lines = ['# Tewip accessibility check', ''];

  lines.push(`Read ${filesRead} markup ${filesRead === 1 ? 'file' : 'files'} under \`${scanned}\`, without rendering any of them.`, '');
  if (browser) {
    lines.push(
      `Also read a ${browser.tool === 'lighthouse' ? 'Lighthouse' : 'axe'} run over ${browser.pages.length} rendered ` +
        `${browser.pages.length === 1 ? 'page' : 'pages'}, ` +
        'which settles what reading markup cannot.',
      '',
    );
  }

  if (barriers.length === 0 && questions.length === 0 && !browser) {
    lines.push('No barrier was found that reading the markup can settle, and nothing needs a decision.', '');
  } else {
    const stopping = barriers.filter((f) => blocks(f.rule)).length;
    const counts = [
      `${barriers.length} ${barriers.length === 1 ? 'barrier' : 'barriers'} (${stopping} that stop somebody outright)`,
      `${questions.length} for a person to settle`,
    ];
    if (accepted.length > 0) counts.push(`${accepted.length} already accepted`);
    if (browser) {
      counts.unshift(`${browser.barriers.length} barriers the browser run proves`);
      if (browser.questions.length > 0) counts.push(`${browser.questions.length} the browser could not determine`);
    }
    lines.push(`**${counts.join(', ')}.**`, '');
  }

  if (browser) {
    renderBrowserSection('Barriers seen in the browser', browser.barriers, lines);
    renderBrowserSection('The browser could not determine these', browser.questions, lines);
  }

  section('Barriers read from the source', [...barriers].sort(worstFirst), lines);
  section('Only a person can settle these', [...questions].sort(worstFirst), lines);

  if (browser && browser.advice.length > 0) {
    // Kept out of the counts above on purpose. These are axe's own best-practice rules, which test
    // no standard: on nine real pages they were 51 of 174 findings, outnumbering every real barrier.
    // Reporting them as equals is how a team learns to ignore the whole report.
    const rules = [...new Set(browser.advice.map((f) => f.rule))].sort();
    lines.push('## Advice, not barriers', '');
    lines.push(
      `${browser.advice.length} ${browser.advice.length === 1 ? 'finding comes' : 'findings come'} from axe rules that map to no WCAG criterion - ` +
        `${rules.join(', ')}. They are somebody's good idea rather than a standard, so they are not counted as barriers ` +
        'and never fail a build. Worth reading once; not worth a release.',
      '',
    );
  }

  if (browser && browser.superseded.length > 0) {
    lines.push('## Set aside, because the browser run checked them', '');
    lines.push(
      `${browser.superseded.length} source ${browser.superseded.length === 1 ? 'finding' : 'findings'} ` +
        'are not listed above: the axe run checked their criterion on a rendered page, so its answer is the better ' +
        'one and repeating them here would count the same barrier twice. They are in the JSON beside this report.',
      '',
    );
  }

  if (accepted.length > 0) {
    lines.push('## Already accepted', '');
    lines.push(`${accepted.length} ${accepted.length === 1 ? 'finding is' : 'findings are'} listed in \`.tewip/access-accepted.txt\`, so they are not repeated here.`, '');
  }

  // Coverage comes from every rule that ran, not from the ones that found something: a contrast
  // check that ran and passed has still checked contrast.
  const ran = browser?.rulesRun ?? new Set<string>();
  const settled = nowChecked(ran);
  const remaining = stillNotChecked(ran);

  if (settled.length > 0) {
    lines.push('## Checked here only because a browser run was given', '');
    for (const n of settled) lines.push(`- **${n.criterion}** - would otherwise be unreachable: ${n.why}`);
    lines.push('');
  }

  lines.push('## What was not checked', '');
  lines.push(
    browser
      ? 'Even with the browser run, none of the following was tested:'
      : 'This read the markup. It did not render a page, so none of the following was tested:',
    '',
  );
  for (const n of remaining) lines.push(`- **${n.criterion}** - ${n.why}`);
  if (browser) {
    lines.push('');
    lines.push(
      `The run covered ${browser.pages.length} ${browser.pages.length === 1 ? 'page' : 'pages'}. ` +
        'Nothing is known about a page it did not open, or about a state it did not reach - a dialog that was never ' +
        'opened, a form that was never submitted, an error that was never triggered.',
    );
  }
  lines.push('');
  lines.push(
    'A clean result here means these checks found nothing, not that the product is accessible. ' +
      'Roughly a third of WCAG can be judged by a machine at all' +
      (browser ? '' : ', and reading source rather than a rendered page reaches less than that') +
      '. The rest needs a person, ideally one who uses a screen reader.',
    '',
  );
  lines.push('To accept a finding, add its key to `.tewip/access-accepted.txt`, one per line, with a reason after ` - `.', '');
  return lines.join('\n');
}

