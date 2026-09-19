// `tewip write`: turn a plan's "to automate next" scenarios into tests in the project's own
// framework. Kept tests stay beside the project's tests for the team to review and commit; every
// other draft is moved to .tewip/drafts with the reason, and nothing is committed or pushed.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { usageLine } from '../llm/usage.ts';
import { chooseFramework, detectFrameworks } from './frameworks.ts';
import { readPages, relatedCodeSources, relatedTestSources } from './grounding.ts';
import { writerFromEnv } from './model.ts';
import type { Plan } from './plan.ts';
import { writeAndVerify, type Outcome } from './write-verify.ts';

export interface WriteCommand {
  root: string;
  plan?: string;
  only: string[];
  framework?: string;
  urls: string[];
  runs: number;
  repairs: number;
  max: number;
  /** Move kept tests here after verifying them, leaving the project's own folders as they were. */
  moveTo?: string;
}

interface SavedPlan {
  plan: Plan;
  feature: string;
  urls: string[];
}

function latestPlan(root: string): string {
  const dir = join(root, '.tewip', 'plans');
  const plans = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)) : [];
  if (plans.length === 0) throw new Error('no plan to write from: run `tewip plan "<feature>"` first, or pass --plan <file.json>');
  return plans.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export async function runWrite(cmd: WriteCommand): Promise<void> {
  const model = writerFromEnv(cmd.root);
  if (!model) throw new Error('writing tests needs a model: set OPENAI_API_KEY (in the environment or a .env file)');
  const planPath = cmd.plan ?? latestPlan(cmd.root);
  const saved = JSON.parse(readFileSync(planPath, 'utf8')) as SavedPlan;

  const found = detectFrameworks(cmd.root);
  const urls = cmd.urls.length ? cmd.urls : saved.urls;
  const detected = chooseFramework(found, cmd.framework, urls.length > 0);
  if (!detected) {
    const seen = found.map((f) => f.id).join(', ') || 'none';
    throw new Error(`no ${cmd.framework ?? 'test'} framework found to write in (found: ${seen}). Tewip writes Playwright, Cypress, WebdriverIO, Angular (ng test), Jest, Vitest, pytest, JUnit (Maven/Gradle), .NET and Go tests.`);
  }
  // Copy the style of the existing test closest to the feature, when it is one of this framework's
  // tests: it shows the helpers and conventions this part of the code base is tested with.
  // Only a test this framework runs: a browser framework runs what is in its test folder; a unit
  // framework runs tests anywhere in its project.
  const within = detected.browser ? detected.testDir : detected.cwd;
  // .ts and .tsx (or .js and .jsx) are the same language; the x only allows JSX, which component tests need.
  const family = (f: string) => extname(f).replace(/x$/, '');
  const sameKind = (f: string) => detected.example !== null && family(f) === family(detected.example) && f.startsWith(within);
  const closest = relatedTestSources(cmd.root, saved.feature, 10).map((t) => join(cmd.root, t.file)).find(sameKind);
  // New tests take the example's own extension, so a component test gets .tsx when its neighbours do.
  const fileFor = (id: string) => (closest ? detected.fileFor(id).replace(/\.[^.]+$/, extname(closest)) : detected.fileFor(id));
  const framework = closest ? { ...detected, example: closest, testDir: dirname(closest), fileFor } : detected;

  const wanted = new Set(cmd.only.map((s) => s.toUpperCase()));
  const scenarios = saved.plan.scenarios.filter((s) => (wanted.size ? wanted.has(s.id.toUpperCase()) : s.automate && !s.covered_by)).slice(0, cmd.max);
  if (scenarios.length === 0) throw new Error(wanted.size ? `none of ${cmd.only.join(', ')} is in ${planPath}` : 'the plan has nothing left to automate');

  const code = relatedCodeSources(cmd.root, saved.feature);
  const { pages, note } = await readPages(urls, cmd.root);
  console.error(`Tewip is writing ${scenarios.length} test(s) in ${framework.label}, in ${relative(cmd.root, framework.testDir) || '.'}${framework.example ? `, in the style of ${relative(cmd.root, framework.example)}` : ''}.`);
  if (note) console.error(`  ${note}`);
  if (!framework.browser && pages.length) console.error('  note: this framework does not drive a browser; pass --framework to pick a browser one if the scenarios need pages.');

  const drafts = join(cmd.root, '.tewip', 'drafts');
  const results: Array<{ id: string; title: string; file: string; outcome: Outcome }> = [];
  for (const scenario of scenarios) {
    const fileName = framework.fileFor(scenario.id);
    const file = join(framework.testDir, fileName);
    if (existsSync(file) || (cmd.moveTo && existsSync(join(cmd.moveTo, fileName)))) {
      results.push({ id: scenario.id, title: scenario.title, file, outcome: { kind: 'rejected', reason: `${fileName} already exists; left untouched`, repairs: 0, passedReliably: false } });
      continue;
    }
    console.error(`  ${scenario.id} ${scenario.title}`);
    // Stopped part-way (Ctrl+C), a draft that was never verified must not stay in the project.
    const leaveNothing = () => {
      if (existsSync(file)) {
        mkdirSync(drafts, { recursive: true });
        renameSync(file, join(drafts, fileName));
      }
      process.exit(130);
    };
    process.once('SIGINT', leaveNothing).once('SIGTERM', leaveNothing);
    let outcome: Outcome;
    try {
      ({ outcome } = await writeAndVerify(model, { framework, fileName, pages, feature: saved.feature, code }, scenario, file, { runs: cmd.runs, repairs: cmd.repairs, log: (l) => console.error(l) }));
    } catch (error) {
      outcome = { kind: 'rejected', reason: `stopped: ${(error as Error).message}`, repairs: 0, passedReliably: false };
    } finally {
      process.off('SIGINT', leaveNothing).off('SIGTERM', leaveNothing);
    }
    if (outcome.kind !== 'kept' && existsSync(file)) {
      mkdirSync(drafts, { recursive: true });
      renameSync(file, join(drafts, fileName));
      if ('lastError' in outcome && outcome.lastError) writeFileSync(join(drafts, `${fileName}.log`), outcome.lastError, 'utf8');
    }
    if (outcome.kind === 'kept' && cmd.moveTo) {
      mkdirSync(cmd.moveTo, { recursive: true });
      renameSync(file, join(cmd.moveTo, fileName));
      results.push({ id: scenario.id, title: scenario.title, file: join(cmd.moveTo, fileName), outcome });
      console.error(`    → kept, moved to ${relative(cmd.root, cmd.moveTo) || '.'}`);
      continue;
    }
    console.error(`    → ${outcome.kind}${outcome.kind === 'kept' ? '' : `: ${outcome.reason}`}`);
    results.push({ id: scenario.id, title: scenario.title, file, outcome });
  }

  const report = renderWriteReport(results, { root: cmd.root, planPath, framework: framework.label, runs: cmd.runs, model: model.model });
  const out = join(cmd.root, '.tewip', 'write', `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, report, 'utf8');
  console.log(report);
  console.error(`\nSaved to ${out}\n${usageLine()}`);
}

export function renderWriteReport(results: Array<{ id: string; title: string; file: string; outcome: Outcome }>, meta: { root: string; planPath: string; framework: string; runs: number; model: string }): string {
  const kept = results.filter((r) => r.outcome.kind === 'kept');
  const bugs = results.filter((r) => r.outcome.kind === 'possible-bug');
  const reliable = results.filter((r) => r.outcome.kind === 'kept' || (r.outcome.kind === 'rejected' && r.outcome.passedReliably));
  const reason = (r: (typeof results)[number]) => (r.outcome.kind === 'rejected' ? r.outcome.reason : '');
  const cannotFail = reliable.filter((r) => reason(r).startsWith('still passes')).length;
  const unproven = reliable.length - kept.length - cannotFail;
  const lines = [
    '# Tewip: tests written',
    '',
    `From ${relative(meta.root, meta.planPath)}, in ${meta.framework}, by ${meta.model}. A test is kept only if it passed ${meta.runs} of ${meta.runs} runs against the working app **and** failed once its main check was broken on purpose.`,
    '',
    `- **Kept: ${kept.length} of ${results.length} drafts.**`,
    `- Mutation check: ${kept.length} of ${reliable.length} test(s) that passed reliably also failed when their check was broken.${cannotFail ? ` ${cannotFail} still passed with it broken, so they could not catch the bug and were dropped.` : ''}${unproven ? ` ${unproven} could not be checked (the break could not be applied or did not run) and were dropped unproven.` : ''}`,
    ...(bugs.length ? [`- **Possible bugs: ${bugs.length}.** The test looked right and the app did something else; a person should look.`] : []),
    '',
    '| Scenario | Result | Why |',
    '|---|---|---|',
    ...results.map((r) => {
      const o = r.outcome;
      const watch = o.kind === 'kept' && o.watch.length ? ` **Review:** may break when the data changes, not the app: \`${o.watch.join('`, `')}\`` : '';
      const why = o.kind === 'kept' ? `checks: ${o.checks}${o.repairs ? ` (after ${o.repairs} repair(s))` : ''}${watch}` : o.reason;
      const where = o.kind === 'kept' ? `kept: \`${relative(meta.root, r.file).replaceAll('\\', '/')}\`` : o.kind === 'possible-bug' ? '**possible bug**' : 'not kept';
      return `| ${r.id} ${r.title.replaceAll('|', '/')} | ${where} | ${why.replace(/\s+/g, ' ').replaceAll('|', '/')} |`;
    }),
    '',
    'Kept tests are new files (beside your tests, or where --move-to put them): review, then commit them yourself. Drafts not kept are in `.tewip/drafts/` with their last error. The broken-on-purpose change is chosen by the model, so it shows the test can fail on its own main check, not that it would catch every bug.',
    '',
  ];
  return lines.join('\n');
}
