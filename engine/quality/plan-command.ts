// `tewip plan`: gather the facts, ask the writing model for a plan, render it, and keep it in
// .tewip/plans (Markdown to review, JSON for `tewip write` to build tests from). The same function
// serves the command line and the MCP server, so an editor's assistant gets the same plan.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageLine } from '../llm/usage.ts';
import { writerFromEnv } from './model.ts';
import { gatherPlanFacts, writePlan } from './plan.ts';
import { renderPlan } from './plan-render.ts';

export interface PlanCommand {
  feature: string;
  root: string;
  diffRange?: string;
  urls: string[];
  out?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'plan';

/** Writes the plan into the project's .tewip/plans and returns it as Markdown, with where it went. */
export async function planProject(cmd: PlanCommand, progress: (line: string) => void = () => {}): Promise<{ markdown: string; out: string }> {
  const model = writerFromEnv(cmd.root);
  if (!model) throw new Error('writing a plan needs a model: set OPENAI_API_KEY (in the environment or a .env file)');
  progress('Tewip is reading the project...');
  const facts = await gatherPlanFacts(cmd);
  progress(`  ${facts.tests.tests.length} existing test(s), ${facts.pages.length} page(s) read${facts.change ? `, ${facts.change.files.length} changed file(s)` : ''}${facts.history.length ? `, ${facts.history.length} past failure(s)` : ''}. Writing the plan...`);
  const plan = await writePlan(facts, model);
  const markdown = renderPlan(plan, facts, model.model);
  const out = cmd.out ?? join(cmd.root, '.tewip', 'plans', `${slug(plan.title)}.md`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, markdown, 'utf8');
  // The same plan as data, for `tewip write`: its scenarios, and the pages it read.
  writeFileSync(out.replace(/\.md$/, '') + '.json', JSON.stringify({ plan, feature: facts.feature, urls: facts.pages.map((p) => p.url), model: model.model }, null, 2), 'utf8');
  return { markdown, out };
}

export async function runPlan(cmd: PlanCommand): Promise<void> {
  const { markdown, out } = await planProject(cmd, (line) => console.error(line));
  console.log(markdown);
  console.error(`\nSaved to ${out}\n${usageLine()}`);
}
