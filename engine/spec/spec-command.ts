// `tewip spec "<feature>"`: the epic, its stories and their acceptance criteria - and, when asked,
// the same items filed in Jira with the restraint the test cases are filed with: nothing is created
// without --create, nothing is ever filed twice, and no ticket is moved, assigned or closed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gatherPlanFacts } from '../quality/plan.ts';
import { writerFromEnv } from '../quality/model.ts';
import { usageLine } from '../llm/usage.ts';
import { Jira, jiraFromEnv, jiraHelp } from '../work/jira.ts';
import { TEWIP_LABEL } from '../work/jira-command.ts';
import { renderSpec, storyBody } from './spec-render.ts';
import { writeSpec, type Spec } from './spec.ts';

export interface SpecCommand {
  feature: string;
  root: string;
  diffRange?: string;
  urls?: string[];
  out?: string;
  /** File the epic and its stories in this Jira project. */
  projectKey?: string;
  /** Without this, Jira is only shown what would be created. */
  create: boolean;
}

export async function runSpec(cmd: SpecCommand): Promise<Spec> {
  const model = writerFromEnv(cmd.root);
  if (!model) throw new Error('writing a specification needs a model. Set TEWIP_API_KEY (and TEWIP_PROVIDER), or OPENAI_API_KEY.');
  const facts = await gatherPlanFacts({ feature: cmd.feature, root: cmd.root, diffRange: cmd.diffRange, urls: cmd.urls });
  const spec = await writeSpec(facts, model);

  const markdown = renderSpec(spec);
  console.log(markdown);

  const dir = join(cmd.root, '.tewip', 'specs');
  mkdirSync(dir, { recursive: true });
  const stem = spec.epic.title.replace(/[^\w.-]+/g, '-').slice(0, 60).toLowerCase() || 'spec';
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify({ feature: cmd.feature, spec }, null, 2), 'utf8');
  const file = cmd.out ? resolve(cmd.out) : join(dir, `${stem}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${markdown}\n`, 'utf8');
  console.log(`\nWritten to ${file}`);

  if (cmd.projectKey) await fileInJira(spec, cmd);
  const usage = usageLine();
  if (usage) console.log(usage);
  return spec;
}

/** The epic and its stories as work items, with the same restraint as `tewip jira`. */
async function fileInJira(spec: Spec, cmd: SpecCommand): Promise<void> {
  const config = jiraFromEnv();
  if (!config) throw new Error(jiraHelp());
  const jira = new Jira(config);
  const project = cmd.projectKey!;
  const types = await jira.issueTypes(project);
  const epicType = ['Epic'].find((t) => types.includes(t));
  const storyType = ['Story', 'User Story', 'Task'].find((t) => types.includes(t)) ?? types[0];
  if (!storyType) throw new Error(`no issue type available in ${project}`);

  const existing = await jira.findByLabel(project, TEWIP_LABEL);
  const filed = (summary: string) => existing.find((i) => i.summary === summary || i.summary.startsWith(`${summary.split(' ')[0]} `));

  const lines = [`Project: ${project} · Epic type: ${epicType ?? '(none in this project)'} · Story type: ${storyType}`, ''];
  const epicSummary = spec.epic.title;
  let epicKey = filed(epicSummary)?.key;
  if (epicKey) lines.push(`  epic already filed as ${epicKey}`);
  else if (!cmd.create) lines.push(`  would create epic: ${epicSummary}`);
  else if (epicType) {
    epicKey = await jira.createIssue({ projectKey: project, type: epicType, summary: epicSummary, description: `${spec.epic.summary}\n\nProblem: ${spec.epic.problem}\n\nValue: ${spec.epic.value}`, labels: [TEWIP_LABEL] });
    lines.push(`  created epic ${epicKey}`);
  }

  for (const story of spec.stories) {
    const summary = `${story.id} ${story.title}`.slice(0, 250);
    const seen = filed(summary);
    if (seen) {
      lines.push(`  ${story.id}  already filed as ${seen.key}`);
      continue;
    }
    if (!cmd.create) {
      lines.push(`  ${story.id}  would create story: ${story.title}`);
      continue;
    }
    const key = await jira.createIssue({
      projectKey: project,
      type: storyType,
      summary,
      description: storyBody(story),
      labels: [TEWIP_LABEL, `tewip-${story.priority.toLowerCase()}`],
      // A story belongs under its epic only where the project really has epics.
      parentKey: epicType && epicKey ? epicKey : undefined,
    });
    lines.push(`  ${story.id}  created ${key}`);
  }
  lines.push('', cmd.create ? 'Tewip never moves, assigns or closes a ticket.' : `Nothing was created. Add --create to file these ${spec.stories.length + 1} item(s).`);
  console.log(`\n${lines.join('\n')}`);
}
