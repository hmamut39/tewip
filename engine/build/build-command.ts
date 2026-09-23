// `tewip build "<what it should do>"`: a feature, written test first and kept only when proved.
//
// The order is the product. Tewip writes the test, runs it, and **requires it to fail** - a test
// that passes before the feature exists is testing nothing, and that single check is what stops a
// model from writing code that agrees with itself. Then it writes the code, and keeps it only when
// the new test passes and nothing that was passing has started to fail.
//
// Nothing is committed. Nothing is merged. What cannot be proved is put back byte for byte.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chooseFramework, detectFrameworks, type Framework } from '../quality/frameworks.ts';
import { existingTests, relatedCodeSources, relatedTestSources } from '../quality/grounding.ts';
import { writerFromEnv } from '../quality/model.ts';
import { usageLine } from '../llm/usage.ts';
import { failingTests } from '../autofix/code-fix.ts';
import { lineDiff, renderDiff } from '../autofix/line-diff.ts';
import { sourceFiles } from '../secure/secrets.ts';
import { applyEdits, Workspace } from './apply.ts';
import { repairFeatureCode, writeFeatureCode, writeFeatureTest, type BuildContext, type CodeChange } from './build.ts';

export interface BuildCommand {
  feature: string;
  root: string;
  /** Put everything back afterwards and only show the patch. */
  dryRun?: boolean;
  /** How many times the code may be corrected from a real failure. */
  repairs?: number;
  /** More than this many changed lines in one file is a rewrite, not a feature. */
  maxLines?: number;
  out?: string;
  /** For the tests: run a command some other way, and use this model. */
  runCommand?: (command: string, cwd: string) => { passed: boolean; output: string };
  model?: import('../llm/client.ts').LlmClient;
}

export type BuildStatus = 'built' | 'test-passes-already' | 'no-code' | 'still-failing' | 'broke-others' | 'no-framework' | 'refused';

export interface BuildResult {
  status: BuildStatus;
  why: string;
  /** The test file Tewip wrote. */
  testFile?: string;
  /** Files it changed or created. */
  files: string[];
  diff: string;
  log: string[];
}

const run = (command: string, cwd: string, env: Record<string, string> | undefined, timeoutMs = 10 * 60_000) => {
  const r = spawnSync(command, { cwd, env: { ...process.env, ...env }, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
  return { passed: r.status === 0, output: output.slice(-6000) };
};

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|cs|php|rs|vue|svelte)$/i;

/**
 * The files that define the things the feature names. Asking for "naturalsize should take a sep
 * argument" and handing the model number.py and time.py - which is what similarity alone did -
 * makes it answer, correctly, that it cannot see the code. The file that defines `naturalsize` is
 * the one it needs, and finding it is a search, not a guess.
 */
export function definingSources(root: string, feature: string, limit = 3): string[] {
  const names = [...new Set((feature.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).filter((w) => /[A-Z_]/.test(w) || w.length > 6))].slice(0, 12);
  if (names.length === 0) return [];
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of sourceFiles(root, 3000)) {
    if (!CODE_FILE.test(file) || /(?:^|[\\/])(?:test|tests|spec|__tests__)[\\/]/i.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // String.raw, because inside a plain template literal "\s" is just "s" and "\b" is a backspace.
    const defines = new RegExp(String.raw`(?:^\s*(?:async\s+)?def\s+|export\s+(?:async\s+)?(?:function|const|class)\s+|function\s+)`, 'm');
    const score = names.filter((n) => new RegExp(`${defines.source}${n}\\b`, 'm').test(text)).length;
    if (score > 0) scored.push({ file, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.file);
}

/** A test file name in the project's own shape, that does not collide with an existing one. */
function testPathFor(framework: Framework, feature: string): string {
  const stem = feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-') || 'feature';
  let path = join(framework.testDir, framework.fileFor(stem));
  let n = 2;
  while (existsSync(path)) path = join(framework.testDir, framework.fileFor(`${stem}-${n++}`));
  return path;
}

/** What the model is shown: the files that define what the feature names, then the similar ones. */
function sourcesFor(root: string, feature: string): Array<{ file: string; content: string }> {
  const defining = definingSources(root, feature).map((file) => ({ file: relative(root, file).split(sep).join('/'), content: readFileSync(file, 'utf8') }));
  const similar = relatedCodeSources(root, feature).map((s) => ({ file: s.file, content: s.content }));
  const seen = new Set(defining.map((s) => s.file));
  return [...defining, ...similar.filter((s) => !seen.has(s.file))].slice(0, 4);
}

export async function runBuild(cmd: BuildCommand): Promise<BuildResult> {
  const root = resolve(cmd.root);
  const model = cmd.model ?? writerFromEnv(root);
  if (!model) throw new Error('building a feature needs a model. Set TEWIP_API_KEY (and TEWIP_PROVIDER), or OPENAI_API_KEY.');
  const runIt = cmd.runCommand ?? ((command: string, cwd: string) => run(command, cwd, framework?.env));

  const framework = chooseFramework(detectFrameworks(root), undefined, false) ?? detectFrameworks(root)[0] ?? null;
  if (!framework) {
    return { status: 'no-framework', why: 'no test framework was found here, and a feature Tewip cannot test is a feature it will not write.', files: [], diff: '', log: [] };
  }

  const tests = existingTests(root);
  const ctx: BuildContext = {
    feature: cmd.feature,
    framework,
    exampleTest: framework.example ? readFileSync(framework.example, 'utf8') : (relatedTestSources(root, cmd.feature)[0]?.content ?? ''),
    sources: sourcesFor(root, cmd.feature),
    testNames: tests.tests,
  };

  const log: string[] = [`framework: ${framework.label}`, `source files read: ${ctx.sources.map((s) => s.file).join(', ') || 'none found'}`];
  const workspace = new Workspace(root);
  const maxLines = cmd.maxLines ?? 120;
  const stop = (status: BuildStatus, why: string): BuildResult => {
    workspace.restore();
    return { status, why, files: [], diff: '', log: [...log, why] };
  };

  // 1. The test, first - and it has to fail.
  console.log('Writing the test first...');
  const draft = await writeFeatureTest(model, ctx);
  const testPath = testPathFor(framework, cmd.feature);
  mkdirSync(dirname(testPath), { recursive: true });
  workspace.write(testPath, draft.code);
  const testRel = relative(root, testPath).split(sep).join('/');
  log.push(`wrote ${testRel}: ${draft.checks}`);

  const before = runIt(framework.command(testPath), framework.cwd);
  if (before.passed) {
    return stop(
      'test-passes-already',
      `the test passes without any new code, so it is not testing the feature. Either ${cmd.feature} already works, or the test checks something that is already true. Nothing was kept.`,
    );
  }
  log.push(`the test fails today, as it must: ${draft.failsBecause}`);

  // What is already broken here, so the feature is never blamed for it.
  const baselineRun = runIt(framework.suite, framework.cwd);
  const alreadyFailing = new Set(baselineRun.passed ? [] : failingTests(baselineRun.output));
  if (alreadyFailing.size > 0) log.push(`${alreadyFailing.size} test(s) were already failing before anything was written, and are not counted against the feature`);

  // 2. The code.
  console.log('Writing the code...');
  let change: CodeChange = await writeFeatureCode(model, ctx, { file: testRel, code: draft.code }, before.output);
  const attempts = Math.max(1, (cmd.repairs ?? 2) + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (change.outcome === 'cannot' || change.edits.length === 0) {
      return stop('no-code', `Tewip did not write code for this: ${change.why || 'it could not see how, from what this project gave it'}. The test it wrote is a good description of what is missing; run \`tewip build\` again with more detail, or write the code yourself against that test.`);
    }
    const { applied, refused } = applyEdits(workspace, root, change.edits, maxLines);
    for (const why of refused) log.push(`refused: ${why}`);
    if (applied.length === 0) {
      return stop('refused', `every change offered was refused: ${refused.join('; ') || 'nothing could be applied'}`);
    }
    log.push(`attempt ${attempt}: changed ${applied.map((e) => `${relative(root, e.path).split(sep).join('/')} (${e.changed} line(s))`).join(', ')}`);

    const after = runIt(framework.command(testPath), framework.cwd);
    if (!after.passed) {
      if (attempt === attempts) return stop('still-failing', 'the test still fails after every attempt, so everything was put back byte for byte.');
      console.log(`The test still fails; correcting (attempt ${attempt + 1})...`);
      change = await repairFeatureCode(model, ctx, { edits: change.edits, output: after.output, broke: [] });
      continue;
    }

    const suite = runIt(framework.suite, framework.cwd);
    const broke = failingTests(suite.output).filter((name) => !alreadyFailing.has(name));
    if (!suite.passed && (broke.length > 0 || failingTests(suite.output).length === 0)) {
      if (attempt === attempts) return stop('broke-others', `the new test passes, but this broke tests that were passing: ${broke.slice(0, 6).join(', ') || 'see the suite output'}. Everything was put back.`);
      console.log('The new test passes but something else broke; correcting...');
      change = await repairFeatureCode(model, ctx, { edits: change.edits, output: suite.output, broke });
      continue;
    }

    // Proved: the new test passes, and nothing that was passing fails.
    log.push('the new test passes, and everything that was passing still passes');
    const diff = [
      renderDiff(testRel, lineDiff('', draft.code)),
      ...applied.map((e) => renderDiff(relative(root, e.path).split(sep).join('/'), lineDiff(e.was ?? '', readFileSync(e.path, 'utf8')))),
    ]
      .filter(Boolean)
      .join('\n');
    const files = [testRel, ...applied.map((e) => relative(root, e.path).split(sep).join('/'))];

    if (cmd.dryRun) {
      workspace.restore();
      log.push('dry run: everything was put back, and only the patch above is yours to apply');
    } else {
      workspace.keep();
    }
    if (cmd.out) {
      mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
      writeFileSync(resolve(cmd.out), `${diff}\n`, 'utf8');
    }
    return { status: 'built', why: change.why, testFile: testRel, files, diff, log };
  }

  return stop('still-failing', 'no change could be proved');
}

/** What the person reads afterwards. */
export function renderBuild(result: BuildResult, feature: string, dryRun: boolean): string {
  const lines = [`# ${result.status === 'built' ? 'Built' : 'Not built'}: ${feature}`, ''];
  for (const line of result.log) lines.push(`- ${line}`);
  lines.push('');
  if (result.status !== 'built') {
    lines.push(result.why, '', 'Nothing was kept. Tewip only leaves code behind when the test it wrote first fails without it and passes with it.');
    return lines.join('\n');
  }
  lines.push(`**What it does.** ${result.why}`, '');
  lines.push('```diff', result.diff, '```', '');
  lines.push(dryRun ? 'This was a dry run: nothing is on disk. Apply the patch above if you want it.' : `Left in your working tree: ${result.files.join(', ')}. Nothing was committed.`);
  lines.push('');
  lines.push('It is proved in the only way that means anything: the test failed without this code and passes with it, and every test that was passing still passes. Read it before you commit it.');
  const usage = usageLine();
  if (usage) lines.push('', usage);
  return lines.join('\n');
}
