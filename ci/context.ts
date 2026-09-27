// What the CI entry point needs from GitHub Actions: action inputs (passed as TRIAGE_* env
// vars by action.yml), the triggering event, and where to read and write files.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface PullRequest {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
}

export interface CiContext {
  workspace: string;
  /** owner/name */
  repo: string;
  /** Our run id, unique per workflow run attempt. */
  runId: string;
  runUrl: string;
  /** For pull requests the PR head commit, not GitHub's temporary merge commit. */
  sha: string;
  branch: string;
  defaultBranch: string;
  pr: PullRequest | null;
  token: string;
  apiUrl: string;
  blobDir: string;
  /** A JUnit XML report (file or directory), for frameworks other than Playwright; null when unset. */
  junitReport: string | null;
  /** Name of this test suite when a workflow triages several; '' for a single suite. */
  suite: string;
  /** 'real-failures': fail the step only on failures that are not a rule's or a person's flaky/ENV. */
  gate: '' | 'real-failures';
  /** Where step outputs go (GITHUB_OUTPUT); null outside Actions. */
  outputFile: string | null;
  historyDir: string;
  outDir: string;
  postPrComment: boolean;
  envIssue: boolean;
  autofix: boolean;
  /** Break the changed code on purpose and report what the tests would not notice. Opt-in: it is slow. */
  prove: boolean;
  proveBudgetSeconds: number;
  verifyCommand: string;
  testsDir: string;
  stepSummary: string | null;
}

const flag = (value: string | undefined, fallback: boolean) => (value === undefined || value === '' ? fallback : value.toLowerCase() === 'true');

export function readCiContext(env: NodeJS.ProcessEnv = process.env): CiContext {
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const inWorkspace = (p: string) => (isAbsolute(p) ? p : join(workspace, p));
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as any) : {};
  const pr: PullRequest | null = event.pull_request
    ? { number: event.pull_request.number, headRef: event.pull_request.head.ref, headSha: event.pull_request.head.sha, baseRef: event.pull_request.base.ref }
    : null;
  const repo = env.GITHUB_REPOSITORY ?? '';
  const githubRunId = env.GITHUB_RUN_ID ?? String(Date.now());

  return {
    workspace,
    repo,
    runId: `gh-${githubRunId}-a${env.GITHUB_RUN_ATTEMPT ?? '1'}`,
    runUrl: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${githubRunId}`,
    sha: pr?.headSha ?? env.GITHUB_SHA ?? '',
    branch: pr?.headRef ?? env.GITHUB_REF_NAME ?? '',
    defaultBranch: event.repository?.default_branch ?? 'main',
    pr,
    token: env.TRIAGE_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? '',
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    blobDir: inWorkspace(env.TRIAGE_BLOB_DIR || 'blob-report'),
    junitReport: env.TRIAGE_JUNIT_REPORT ? inWorkspace(env.TRIAGE_JUNIT_REPORT) : null,
    suite: (env.TRIAGE_SUITE ?? '').trim(),
    gate: env.TRIAGE_GATE?.trim() === 'real-failures' ? 'real-failures' : '',
    outputFile: env.GITHUB_OUTPUT || null,
    historyDir: inWorkspace(env.TRIAGE_HISTORY_DIR || '.triage-agent/history'),
    outDir: inWorkspace(env.TRIAGE_OUT_DIR || '.triage-agent/out'),
    postPrComment: flag(env.TRIAGE_POST_PR_COMMENT, true),
    envIssue: flag(env.TRIAGE_ENV_ISSUE, true),
    autofix: flag(env.TRIAGE_AUTOFIX, false),
    prove: flag(env.TEWIP_PROVE, false),
    proveBudgetSeconds: Number(env.TEWIP_PROVE_BUDGET ?? '300') || 300,
    verifyCommand: env.TRIAGE_VERIFY_COMMAND || 'npx playwright test',
    testsDir: env.TRIAGE_TESTS_DIR || 'tests',
    stepSummary: env.GITHUB_STEP_SUMMARY || null,
  };
}
