// `tewip fix --code <report>`: the opt-in loop that may change application code.
//
// It reads a test report, diagnoses it exactly as `tewip explain` does, and takes only the failures
// the engine calls a real bug with high confidence. For each, it finds the file the stack names,
// asks for the smallest change, and then proves it: the failing test must pass and the whole suite
// must still pass. Nothing is applied to the branch - the change is written out as a patch file for
// a person to read, apply and open as a pull request.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCorrections } from '../corrections.ts';
import { HistoryIndex } from '../history.ts';
import { importJunit } from '../import/junit.ts';
import { importBlobReportDir } from '../import/blob.ts';
import { llmFromEnv } from '../llm/client.ts';
import { writerFromEnv } from '../quality/model.ts';
import { usageLine } from '../llm/usage.ts';
import { buildItems } from '../../outlets/items.ts';
import { chooseFramework, detectFrameworks, type Framework } from '../quality/frameworks.ts';
import { attemptCodeFix, type CodeFixResult } from './code-fix.ts';

export interface CodeFixCommand {
  root: string;
  /** A JUnit XML or TRX file, a folder of them, or a Playwright blob report folder. */
  report: string;
  /** Only these test titles or ids. */
  only: string[];
  /** How many failures to try in one run. */
  max: number;
  /** Leave a proved change in the working tree instead of only writing the patch. */
  apply: boolean;
  /** Override the command that runs the whole suite, when the project's is unusual. */
  suiteCommand?: string;
}

const SUITE_TIMEOUT_MS = 20 * 60_000;

function run(command: string, cwd: string, env: Record<string, string> | undefined, timeoutMs: number): { passed: boolean; output: string } {
  const r = spawnSync(command, { cwd, env: { ...process.env, ...env }, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
  return { passed: r.status === 0, output: output.slice(-6000) };
}

const isBlobDir = (path: string): boolean => statSync(path).isDirectory() && readdirSync(path).some((f) => /^report.*\.zip$/.test(f));

/** The test file a record points at, as an absolute path in this project. */
function testFileOf(file: string, root: string): string | null {
  const direct = resolve(root, file);
  return existsSync(direct) ? direct : null;
}

export async function runCodeFix(cmd: CodeFixCommand): Promise<CodeFixResult[]> {
  // Fixing code is writing code, so it uses the writing model, not the small triage one.
  const model = writerFromEnv(cmd.root);
  if (!model) throw new Error('fixing code needs a model. Set TEWIP_API_KEY (and TEWIP_PROVIDER), or OPENAI_API_KEY.');
  const path = resolve(cmd.report);
  if (!existsSync(path)) throw new Error(`no such report: ${cmd.report}`);

  const name = basename(statSync(path).isDirectory() ? path : dirname(path)).replace(/[^\w.-]+/g, '-');
  const historyDir = join(cmd.root, '.tewip', 'history', name);
  const meta = { runId: `fix-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`, gitSha: '', workspace: cmd.root };
  const imported = isBlobDir(path) ? importBlobReportDir(path, meta, join(historyDir, 'files')) : importJunit(path, meta);
  const index = new HistoryIndex(imported.records, [imported.summary]);
  const items = await buildItems(imported.records, index, { dataset: `local: ${name}`, llm: model, corrections: loadCorrections(historyDir) });

  const wanted = new Set(cmd.only.map((s) => s.toLowerCase()));
  const candidates = items.filter((i) => i.diagnosis.category === 'REAL_BUG' && i.action.kind === 'file-bug' && i.diagnosis.confidence >= 0.85)
    .filter((i) => (wanted.size ? wanted.has(i.testId.toLowerCase()) || wanted.has(i.title.toLowerCase()) : true));

  if (items.length === 0) {
    console.log('Every test in that report passed. Nothing to fix.');
    return [];
  }
  if (candidates.length === 0) {
    const kinds = [...new Set(items.map((i) => `${i.diagnosis.category} ${i.diagnosis.confidence.toFixed(2)}`))].slice(0, 5).join(', ');
    console.log(`None of the ${items.length} failure(s) is a real bug Tewip is confident enough about to touch code for (${kinds}).`);
    console.log('Run `tewip explain` on the same report to see what it says about each one.');
    return [];
  }

  const frameworks = detectFrameworks(cmd.root);
  const results: CodeFixResult[] = [];
  const patchDir = join(cmd.root, '.tewip', 'fixes');

  for (const item of candidates.slice(0, cmd.max)) {
    const record = imported.records.find((r) => r.testId === item.testId && r.runId === item.runId) ?? imported.records.find((r) => r.testId === item.testId);
    if (!record) continue;
    const testFile = testFileOf(item.file, cmd.root);
    console.log(`\n${item.title}\n  ${item.errorHead}`);
    if (!testFile) {
      console.log(`  skipped: the report says the test is in ${item.file}, which is not in this project. Run this in the project the tests came from.`);
      continue;
    }
    const framework: Framework | null = chooseFramework(frameworks, undefined, false) ?? frameworks[0] ?? null;
    if (!framework) {
      console.log('  skipped: no test framework found here, so a fix could not be proved by running the tests.');
      continue;
    }
    const suiteCommand = cmd.suiteCommand ?? framework.suite;

    const result = await attemptCodeFix(
      { record, diagnosis: item.diagnosis, action: item.action, testSource: readFileSync(testFile, 'utf8'), testFile },
      {
        root: cmd.root,
        readFile: (p) => readFileSync(p, 'utf8'),
        writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
        runTest: async () => run(framework.command(testFile), framework.cwd, framework.env, 10 * 60_000),
        runSuite: async () => run(suiteCommand, framework.cwd, framework.env, SUITE_TIMEOUT_MS),
        model,
      },
      { keep: cmd.apply },
    );
    results.push(result);

    for (const line of result.log) console.log(`  ${line}`);
    if (result.status === 'fixed' && result.diff) {
      mkdirSync(patchDir, { recursive: true });
      const patch = join(patchDir, `${item.title.replace(/[^\w.-]+/g, '-').slice(0, 60)}.patch`);
      writeFileSync(patch, `${result.diff}\n`, 'utf8');
      console.log(`\n  Why: ${result.why}`);
      console.log(`  ${result.diff.split('\n').map((l) => `  ${l}`).join('\n  ')}`);
      console.log(`\n  Patch written to ${patch}`);
      console.log(cmd.apply ? '  The change is in your working tree. Review it, then commit it yourself.' : '  The file was put back as it was. Apply the patch yourself if you agree with it.');
    } else {
      console.log(`  no code change: ${result.why ?? result.status}`);
    }
  }

  console.log(`\n${results.filter((r) => r.status === 'fixed').length} of ${Math.min(candidates.length, cmd.max)} attempted failure(s) got a change proved by the tests.`);
  console.log('Tewip never commits, never merges, and never changes a test to make a fix look green.');
  const usage = usageLine();
  if (usage) console.log(usage);
  return results;
}
