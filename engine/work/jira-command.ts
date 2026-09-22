// `tewip jira`: the plan Tewip wrote, as work items a team can actually pick up.
//
// Two rules shape this. It shows what it would create and creates nothing until asked (--create),
// because filing twenty tickets by accident in someone's backlog is unforgivable. And it files a
// scenario only once: every issue it creates carries a label, so a second run finds them and skips
// what is already there rather than making duplicates.
import { readFileSync } from 'node:fs';
import type { Plan } from '../quality/plan.ts';
import { Jira, jiraFromEnv, jiraHelp, type JiraIssue } from './jira.ts';

export const TEWIP_LABEL = 'tewip';

export interface JiraCommand {
  /** The plan file written by `tewip plan` (.json). */
  planFile: string;
  projectKey: string;
  /** The issue type to create; the project's own types are checked first. */
  type?: string;
  /** The story these test cases belong to, linked afterwards. */
  issueKey?: string;
  /** Without this, nothing is created: the command only shows what it would do. */
  create: boolean;
  /** Only these scenario ids. */
  only: string[];
}

interface SavedPlan {
  plan: Plan;
  feature: string;
}

type Scenario = Plan['scenarios'][number];

/** One test case, written the way a person reads it rather than as JSON. */
export function issueBody(scenario: Scenario, feature: string, source?: string): string {
  return [
    scenario.title,
    '',
    `Feature: ${feature}`,
    source ? `From: ${source}` : '',
    `Priority: ${scenario.priority} · Type: ${scenario.type}`,
    scenario.preconditions ? `\nGiven: ${scenario.preconditions}` : '',
    '',
    'Steps:',
    ...scenario.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `Expected: ${scenario.expected}`,
    '',
    `Grounded on: ${scenario.grounded_on}`,
    scenario.covered_by ? `Already covered by: ${scenario.covered_by}` : 'Not covered by an existing test.',
    '',
    'Written by Tewip from the plan; review before you rely on it.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The scenarios worth filing: everything not already covered by a test, unless asked for by id. */
function chosen(plan: Plan, only: string[]): Scenario[] {
  const wanted = new Set(only.map((s) => s.toUpperCase()));
  return plan.scenarios.filter((s) => (wanted.size ? wanted.has(s.id.toUpperCase()) : !s.covered_by));
}

export async function runJira(cmd: JiraCommand): Promise<void> {
  const config = jiraFromEnv();
  if (!config) throw new Error(jiraHelp());
  const jira = new Jira(config);
  const saved = JSON.parse(readFileSync(cmd.planFile, 'utf8')) as SavedPlan;
  const scenarios = chosen(saved.plan, cmd.only);
  if (scenarios.length === 0) throw new Error(cmd.only.length ? `none of ${cmd.only.join(', ')} is in ${cmd.planFile}` : 'every scenario in the plan is already covered by a test');

  // Use a type the project really has: "Test" exists in some projects and not others.
  const types = await jira.issueTypes(cmd.projectKey);
  const type = cmd.type ?? ['Test', 'Test Case', 'Task'].find((t) => types.includes(t)) ?? types[0];
  if (!type) throw new Error(`no issue type available in ${cmd.projectKey}`);
  if (cmd.type && !types.includes(cmd.type)) throw new Error(`${cmd.projectKey} has no issue type "${cmd.type}". It has: ${types.join(', ')}`);

  // Already filed by an earlier run: match on the title, which carries the scenario id.
  const existing = await jira.findByLabel(cmd.projectKey, TEWIP_LABEL);
  const alreadyThere = (s: Scenario) => existing.find((i) => i.summary.startsWith(`${s.id} `) || i.summary === s.title);

  const lines: string[] = [`Plan: ${saved.plan.title}`, `Project: ${cmd.projectKey} · Issue type: ${type}${cmd.issueKey ? ` · Linked to: ${cmd.issueKey}` : ''}`, ''];
  let created = 0;
  for (const scenario of scenarios) {
    const seen = alreadyThere(scenario);
    if (seen) {
      lines.push(`  ${scenario.id}  already filed as ${seen.key}`);
      continue;
    }
    if (!cmd.create) {
      lines.push(`  ${scenario.id}  would create: ${scenario.id} ${scenario.title}`);
      continue;
    }
    const key = await jira.createIssue({
      projectKey: cmd.projectKey,
      type,
      summary: `${scenario.id} ${scenario.title}`,
      description: issueBody(scenario, saved.feature, cmd.issueKey),
      labels: [TEWIP_LABEL, `tewip-${scenario.priority.toLowerCase()}`],
    });
    if (cmd.issueKey) await jira.link(cmd.issueKey, key).catch(() => lines.push(`  (could not link ${key} to ${cmd.issueKey}; the issue was still created)`));
    lines.push(`  ${scenario.id}  created ${key}`);
    created++;
  }
  lines.push('', cmd.create ? `${created} issue(s) created. Tewip never moves, assigns or closes a ticket.` : `Nothing was created. Add --create to file these ${scenarios.length} item(s).`);
  console.log(lines.join('\n'));
}

/** The facts a plan should be built from when it starts at a ticket rather than a sentence. */
export function featureFromIssue(issue: JiraIssue): string {
  return [
    `${issue.key}: ${issue.summary}`,
    issue.description ? `\n${issue.description}` : '',
    issue.acceptanceCriteria ? `\nAcceptance criteria:\n${issue.acceptanceCriteria}` : '',
  ]
    .join('')
    .slice(0, 6000);
}
