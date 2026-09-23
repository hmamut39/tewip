// `tewip report <report>`: the CI command for teams that are not on GitHub Actions.
//
// It does what Tewip's GitHub Action does, without any of GitHub in it: diagnose the run, write the
// board where the platform shows things, post the diagnosis on the merge request when that is
// GitLab, tell the team's chat only when something needs a person, and fail the build only on
// failures that are not known noise.
//
// Nothing here is platform-specific except the edges, which are read from the CI's own variables.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadCorrections } from '../corrections.ts';
import { HistoryIndex } from '../history.ts';
import { importJunit } from '../import/junit.ts';
import { importBlobReportDir } from '../import/blob.ts';
import { llmFromEnv } from '../llm/client.ts';
import { usageLine } from '../llm/usage.ts';
import { buildItems, type TriageItem } from '../../outlets/items.ts';
import { sdetBoardView } from '../../outlets/views/sdet.ts';
import { gate, gateSummary } from '../../ci/gate.ts';
import { appendJsonl, datasetFiles, readRunSummaries, readTriageRecords } from '../../reporters/store.ts';
import { ciFacts, summaryFile } from './platform.ts';
import { GitLab, gitlabFromEnv } from './gitlab.ts';
import { chatFromEnv, chatMessage, postToChat } from '../notify/chat.ts';

export interface ReportCommand {
  root: string;
  /** A JUnit XML or TRX file, a folder of them, or a Playwright blob report folder. */
  report: string;
  /** Keep this project's history apart from others. */
  name?: string;
  /** Write the report here as well. */
  out?: string;
  /** Fail the process when a failure needs a person. */
  gate: boolean;
  /** Post to the merge request and the team chat. Off for a dry run. */
  post: boolean;
}

const isBlobDir = (path: string): boolean => statSync(path).isDirectory() && readdirSync(path).some((f) => /^report.*\.zip$/.test(f));

export async function runReport(cmd: ReportCommand): Promise<{ items: TriageItem[]; blocking: number }> {
  const path = resolve(cmd.report);
  if (!existsSync(path)) throw new Error(`no such report: ${cmd.report}`);
  const facts = ciFacts();
  const name = (cmd.name ?? facts.project.split('/').pop() ?? basename(statSync(path).isDirectory() ? path : dirname(path))).replace(/[^\w.-]+/g, '-');
  const historyDir = join(cmd.root, '.tewip', 'history', name);
  const history = datasetFiles(historyDir);
  const runId = facts.runId || `local-${Date.now()}`;
  const meta = { runId, gitSha: facts.sha, workspace: cmd.root };

  const imported = isBlobDir(path) ? importBlobReportDir(path, meta, join(historyDir, 'files')) : importJunit(path, meta);
  const past = readTriageRecords(history.triage);
  const pastRuns = readRunSummaries(history.runs);
  const index = new HistoryIndex([...past, ...imported.records], [...pastRuns, imported.summary]);
  const items = await buildItems(imported.records, index, { dataset: `${facts.label}: ${name}`, llm: llmFromEnv(), corrections: loadCorrections(historyDir) });

  const decided = gate(items);
  const tests = Object.keys(imported.summary.attempts).length;
  const where = [facts.label, facts.project, facts.branch].filter(Boolean).join(' · ');
  const head = `Tewip on ${where || 'this machine'}${facts.changeRequest ? ` · merge request ${facts.changeRequest}` : ''}`;
  const body = items.length === 0
    ? `## ${head}\n\nAll ${tests} test(s) passed.`
    : `## ${head}\n\n${sdetBoardView(items, runId, `${facts.label}: ${name}`).markdown}\n\n${facts.runUrl ? `[The run](${facts.runUrl})` : ''}`;

  console.log(body);
  console.log(`\n${gateSummary(decided)}`);

  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${body}\n`, 'utf8');
    console.log(`Written to ${cmd.out}`);
  }
  const summary = summaryFile();
  if (summary) appendFileSync(summary, `${body}\n`, 'utf8');

  if (cmd.post && items.length > 0) await postEverywhere(facts, body, items, decided.blocking);

  // Keep this run as history, so the next one is judged against it - the same memory the Action has.
  const diagnosed = imported.records.map((r) => ({ ...r, diagnosis: items.find((i) => i.testId === r.testId)?.diagnosis }));
  appendJsonl(history.triage, diagnosed);
  appendJsonl(history.runs, [imported.summary]);
  const usage = usageLine();
  if (usage) console.log(usage);

  return { items, blocking: decided.blocking.length };
}

/** The merge request note and the chat message, each skipped quietly when not set up. */
async function postEverywhere(facts: ReturnType<typeof ciFacts>, body: string, items: TriageItem[], blocking: TriageItem[]): Promise<void> {
  if (facts.platform === 'gitlab' && facts.changeRequest) {
    const config = gitlabFromEnv();
    if (config) {
      try {
        await new GitLab(config).postReport(facts.changeRequest, body);
        console.log(`Posted on merge request ${facts.changeRequest}.`);
      } catch (error) {
        console.log(`Could not post on the merge request (the report is still above): ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log('Not posted on the merge request: set TEWIP_GITLAB_TOKEN to let Tewip comment.');
    }
  }

  const targets = chatFromEnv();
  if (!targets.slack && !targets.teams) return;
  const message = chatMessage(items, blocking, { project: facts.project, branch: facts.branch, runUrl: facts.runUrl });
  try {
    const sent = await postToChat(message, targets);
    console.log(sent.length > 0 ? `Told ${sent.join(' and ')}.` : 'Nothing needs a person, so the team chat was left alone.');
  } catch (error) {
    console.log(`Could not post to chat: ${error instanceof Error ? error.message : String(error)}`);
  }
}
