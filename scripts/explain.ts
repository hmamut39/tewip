// Explains a test report on your own machine, no CI needed: run your tests, then
//   node scripts/explain.ts <report>
// where <report> is a JUnit XML or TRX file, a directory of them, a Playwright blob report
// directory, or a CI job log (.log/.txt) from a job that died before any test ran. Works for any stack the importer reads (see QUICKSTART.md). Each run is kept in a
// .tewip folder in the directory you run it from (your project, not the installed tool), so later
// runs judge failures against their history, as CI does.
// Options: --name <project> keeps a separate history per project (default: the report's folder).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadCorrections } from '../engine/corrections.ts';
import { HistoryIndex } from '../engine/history.ts';
import { importBlobReportDir } from '../engine/import/blob.ts';
import { importJunit } from '../engine/import/junit.ts';
import { llmFromEnv } from '../engine/llm/client.ts';
import { usageLine } from '../engine/llm/usage.ts';
import { buildItems } from '../outlets/items.ts';
import { sdetBoardView } from '../outlets/views/sdet.ts';
import { appendJsonl, datasetFiles, readRunSummaries, readTriageRecords } from '../reporters/store.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** A Playwright blob report is a directory of report-*.zip files; anything else is JUnit or TRX. */
function isBlobDir(path: string): boolean {
  return statSync(path).isDirectory() && readdirSync(path).some((f) => /^report.*\.zip$/.test(f));
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target.startsWith('--') || !existsSync(target)) {
    console.error('usage: node scripts/explain.ts <report.xml | report.trx | reports-dir | blob-report-dir | job.log> [--name project]');
    process.exitCode = 1;
    return;
  }
  const path = resolve(target);
  // A job log rather than a test report: the job died before any test ran, and the log is the only
  // thing left that says why. Answer from it instead of refusing.
  if (!statSync(path).isDirectory() && /\.(log|txt)$/i.test(path)) {
    const { diagnoseLog, renderLogDiagnosis } = await import('../engine/import/log.ts');
    console.log(renderLogDiagnosis(diagnoseLog(readFileSync(path, 'utf8')), basename(path)));
    return;
  }
  const name = (arg('name') ?? basename(statSync(path).isDirectory() ? path : dirname(path))).replace(/[^\w.-]+/g, '-');
  const historyDir = join(process.cwd(), '.tewip', 'history', name);
  const history = datasetFiles(historyDir);
  const runId = `local-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const meta = { runId, gitSha: '', workspace: process.cwd() };

  const imported = isBlobDir(path) ? importBlobReportDir(path, meta, join(historyDir, 'files')) : importJunit(path, meta);
  const pastRecords = readTriageRecords(history.triage);
  const pastRuns = readRunSummaries(history.runs);
  const index = new HistoryIndex([...pastRecords, ...imported.records], [...pastRuns, imported.summary]);

  const items = await buildItems(imported.records, index, { dataset: `local: ${name}`, llm: llmFromEnv(), corrections: loadCorrections(historyDir) });
  const tests = Object.keys(imported.summary.attempts).length;
  // A report missing part of itself is not a report that nothing went wrong. This goes first,
  // above any board and in place of any all-clear, because it changes what everything below means.
  if (imported.incomplete.length > 0) {
    console.log('**This run is incomplete.**');
    for (const why of imported.incomplete) console.log(`- ${why}`);
    console.log('');
  }
  if (items.length === 0) {
    console.log(
      imported.incomplete.length > 0
        ? `The ${tests} test(s) that did arrive all passed. That is not the same as the run passing, and Tewip cannot say whether the missing part did.`
        : `All ${tests} test(s) passed. Nothing to explain.`,
    );
  } else console.log(sdetBoardView(items, runId, `local: ${name}`).markdown);

  // Keep this run as history for the next one, with its diagnoses.
  const diagnosed = imported.records.map((r) => ({ ...r, diagnosis: items.find((i) => i.testId === r.testId)?.diagnosis }));
  appendJsonl(history.triage, diagnosed);
  appendJsonl(history.runs, [imported.summary]);
  const runs = pastRuns.length + 1;
  console.log(`\n${usageLine()}`);
  console.log(`History: ${runs} run(s) of "${name}" kept in ${historyDir}.${runs === 1 ? ' A test\'s first failure often stays undecided; later runs are judged against this one. Add .tewip/ to your .gitignore.' : ''}`);
}

await main();
