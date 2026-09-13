/**
 * Resolves the run id once per `playwright test` invocation. The value is stored in
 * process.env so the config (for the per-run outputDir), the reporter and worker
 * processes (which inherit env) all agree on it.
 */
export function resolveRunId(): string {
  const existing = process.env.TRIAGE_RUN_ID;
  if (existing) return existing;
  const runId = process.env.CI_RUN_ID || `run-${new Date().toISOString().replace(/[-:.]/g, '')}`;
  process.env.TRIAGE_RUN_ID = runId;
  return runId;
}

export function resolveGitSha(): string {
  return process.env.GIT_SHA || process.env.GITHUB_SHA || '';
}
