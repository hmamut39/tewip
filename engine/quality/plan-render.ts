// Renders a test plan as Markdown a team can review, with the facts it was built from listed at the
// end, so a reader can tell grounded scenarios from ones to confirm.
import type { Plan, PlanFacts } from './plan.ts';

const cell = (s: string) => s.replaceAll('|', '/').replace(/\s+/g, ' ').trim();

export function renderPlan(plan: Plan, facts: PlanFacts, model: string): string {
  const byPriority = (p: string) => plan.scenarios.filter((s) => s.priority === p);
  const lines: string[] = [
    `# Test plan: ${plan.title}`,
    '',
    `> Draft by Tewip (${model}). Review before use: every scenario says what it is grounded on.`,
    '',
    plan.summary,
    '',
    '## Scope',
    ...plan.scope.map((s) => `- ${s}`),
    ...(plan.out_of_scope.length ? ['', '**Out of scope:**', ...plan.out_of_scope.map((s) => `- ${s}`)] : []),
    '',
    '## Risks',
    '',
    '| Severity | Risk | Why |',
    '|---|---|---|',
    ...plan.risks.map((r) => `| ${r.severity} | ${cell(r.risk)} | ${cell(r.why)} |`),
    '',
    '## Scenarios',
  ];
  for (const p of ['P0', 'P1', 'P2']) {
    const xs = byPriority(p);
    if (xs.length === 0) continue;
    lines.push('', `### ${p} (${xs.length})`);
    for (const s of xs) {
      lines.push(
        '',
        `**${s.id}. ${s.title}** — ${s.type}${s.automate ? ', automate' : ', manual'}${s.covered_by ? ` · already covered by \`${s.covered_by}\`` : ''}`,
        ...(s.preconditions ? [`- Given: ${s.preconditions}`] : []),
        ...s.steps.map((step, i) => `${i + 1}. ${step}`),
        `- Expected: ${s.expected}`,
        `- Grounded on: ${s.grounded_on}`,
      );
    }
  }
  const automate = plan.scenarios.filter((s) => s.automate && !s.covered_by);
  lines.push('', '## To automate next', '', automate.length ? automate.map((s) => `- ${s.id} ${s.title} (${s.priority})`).join('\n') : 'Nothing new: existing tests cover the automatable scenarios.');
  if (plan.open_questions.length) lines.push('', '## Open questions', ...plan.open_questions.map((q) => `- ${q}`));
  lines.push(
    '',
    '## What this plan was built from',
    `- Feature description: ${facts.feature.length > 200 ? `${facts.feature.slice(0, 200)}…` : facts.feature}`,
    `- Change: ${facts.change ? `${facts.change.range}, ${facts.change.files.length} file(s)` : 'none given'}`,
    `- Pages read: ${facts.pages.length ? facts.pages.map((p) => p.url).join(', ') : facts.pagesNote ?? 'none given'}`,
    `- Existing tests: ${facts.tests.tests.length} named in ${facts.tests.files} file(s)${facts.testSources?.length ? `; read in full: ${facts.testSources.map((t) => t.file).join(', ')}` : ''}`,
    `- Failure history: ${facts.history.length ? `${facts.history.length} test(s) Tewip diagnosed before` : 'none recorded yet'}`,
    '',
  );
  return lines.join('\n');
}
