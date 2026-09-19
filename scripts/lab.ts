// Drift lab: runs the whole agent loop (collect -> diagnose -> decide -> auto-fix -> verify)
// on a local demo app whose v2 release changes the UI, then scores it against lab/cases.json.
// Everything happens on this machine: tests are copied into data/lab/sandbox (the only place
// the loop may edit), and the "PR" is a markdown file. SYNTHETIC by design: NOT a product metric.
// Usage: node scripts/lab.ts [--no-llm]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { attemptFix, fixDiff, type FixResult } from '../engine/autofix/autofix.ts';
import { lastFailedAttempts, loadDataset } from '../engine/dataset.ts';
import { HistoryIndex } from '../engine/history.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { readPageSnapshot } from '../engine/snapshot.ts';
import { buildItems } from '../outlets/items.ts';
import { DATA_DIR, PROJECT_ROOT } from '../reporters/store.ts';
import { renderTable } from './table.ts';

const LAB = join(PROJECT_ROOT, 'lab');
const WORK = join(DATA_DIR, 'lab');
const SANDBOX = join(WORK, 'sandbox', 'tests');
const CONFIG = join(LAB, 'playwright.config.ts');
const CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');

interface Truth {
  cause: string;
  fixable: boolean;
  change: string;
}

function playwright(version: 'v1' | 'v2', args: string[], dataDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, LAB_VERSION: version, LAB_TEST_DIR: SANDBOX, GIT_SHA: `lab-${version}`, TRIAGE_LLM: 'off', TRIAGE_DATA_DIR: dataDir };
  delete env.TRIAGE_RUN_ID;
  delete env.CI_RUN_ID;
  return spawnSync(process.execPath, [CLI, 'test', '--config', CONFIG, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
}

/** VERIFY: re-run one test against v2 with the JSON reporter; true only if it ran and passed. */
async function verify(_spec: string, title: string): Promise<{ passed: boolean; detail: string }> {
  const grep = `${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  const run = playwright('v2', ['--reporter=json', '-g', grep], join(WORK, 'verify'));
  try {
    const json = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'), run.stdout.lastIndexOf('}') + 1)) as { stats: { expected: number; unexpected: number } };
    const passed = json.stats.expected >= 1 && json.stats.unexpected === 0;
    return { passed, detail: `${json.stats.expected} passed, ${json.stats.unexpected} failed` };
  } catch {
    return { passed: false, detail: `could not read the test result (exit ${run.status})` };
  }
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  cpSync(join(LAB, 'tests'), SANDBOX, { recursive: true });
  const collect = relative(PROJECT_ROOT, WORK);

  console.log('[lab] 1/4 baseline: 3 runs against v1 (history the agent will see)');
  for (let i = 0; i < 3; i++) {
    const run = playwright('v1', [], collect);
    if (run.status !== 0) throw new Error(`the tests must pass on v1 before the lab means anything:\n${run.stdout.slice(-2000)}`);
  }
  console.log('[lab] 2/4 release: 1 run against v2');
  playwright('v2', [], collect);

  console.log('[lab] 3/4 diagnose + decide');
  const dataset = loadDataset(collect);
  const index = new HistoryIndex(dataset.records, dataset.summaries);
  const llm = process.argv.includes('--no-llm') ? null : llmFromEnv();
  const items = await buildItems(dataset.records, index, { dataset: 'drift lab (synthetic)', llm });
  const records = lastFailedAttempts(dataset.records);

  console.log('[lab] 4/4 auto-fix + verify (sandbox only)');
  const fixes: FixResult[] = [];
  for (const item of items) {
    const record = records.find((r) => r.runId === item.runId && r.testId === item.testId)!;
    fixes.push(
      await attemptFix(
        { record, diagnosis: item.diagnosis, action: item.action, specFile: join(PROJECT_ROOT, record.file) },
        {
          allowedRoot: SANDBOX,
          readFile: (p) => readFileSync(p, 'utf8'),
          writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
          verify,
          loadSnapshot: readPageSnapshot,
        },
      ),
    );
  }

  const cases = JSON.parse(readFileSync(join(LAB, 'cases.json'), 'utf8')) as Record<string, Truth>;
  const rows = items.map((item, i) => ({ item, fix: fixes[i], truth: cases[item.title] }));
  console.log(
    '\n' +
      renderTable(
        ['Test', 'Truth', 'Diagnosis', 'Conf', 'Action', 'Auto-fix'],
        rows.map(({ item, fix, truth }) => [item.title, truth?.cause ?? '?', item.diagnosis.category, item.diagnosis.confidence.toFixed(2), item.action.kind, fix.status]),
      ),
  );

  const fixable = rows.filter((r) => r.truth?.fixable);
  const notFixable = rows.filter((r) => r.truth && !r.truth.fixable);
  const fixed = fixable.filter((r) => r.fix.applied);
  const falsePositives = notFixable.filter((r) => r.fix.applied);
  const classified = rows.filter((r) => r.truth && r.item.diagnosis.category === r.truth.cause).length;

  mkdirSync(join(WORK, 'fixes'), { recursive: true });
  const accepted = rows.filter((r) => r.fix.applied);
  const pr = [
    `# Fix ${accepted.length} drifted locator(s) (verified by re-running each test)`,
    '',
    'Opened by Tewip in the drift lab. Only test code changed; every change was re-run against v2 and passed. A human reviews and merges.',
    '',
    ...accepted.flatMap(({ item, fix }) => [
      `## ${item.title}`,
      `Diagnosis: ${item.diagnosis.category}, confidence ${item.diagnosis.confidence.toFixed(2)}, source: ${item.source}`,
      '',
      '```diff',
      fixDiff(fix, relative(SANDBOX, fix.specFile).replaceAll('\\', '/')),
      '```',
      ...fix.log.map((l) => `- ${l}`),
      '',
    ]),
  ].join('\n');
  writeFileSync(join(WORK, 'fixes', 'PR.md'), pr, 'utf8');
  writeFileSync(join(WORK, 'fixes', 'log.json'), JSON.stringify(fixes, null, 2), 'utf8');

  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`);
  console.log(`\nDataset: drift lab, ${rows.length} failures on lab/app/v2. SYNTHETIC: proves the loop works, NOT a product metric.`);
  console.log(`Classification: ${classified}/${rows.length} correct (${pct(classified, rows.length)})`);
  console.log(`Auto-fix success: ${fixed.length}/${fixable.length} drifted locators fixed and verified (${pct(fixed.length, fixable.length)})`);
  console.log(`False positives: ${falsePositives.length}/${notFixable.length} non-drift failures got an accepted "fix" (${pct(falsePositives.length, notFixable.length)})`);
  console.log(`Local PR: ${relative(PROJECT_ROOT, join(WORK, 'fixes', 'PR.md'))}; full action log: ${relative(PROJECT_ROOT, join(WORK, 'fixes', 'log.json'))}`);
}

if (import.meta.main) await main();
