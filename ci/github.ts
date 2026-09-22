// Minimal GitHub REST client for the delivery step: one updatable PR comment, one grouped
// environment issue, and fix pull requests. Uses the workflow's token; never merges anything.

export interface IssueRef {
  number: number;
  html_url: string;
}

export class GitHub {
  private readonly token: string;
  private readonly repo: string;
  private readonly apiUrl: string;

  constructor(token: string, repo: string, apiUrl = 'https://api.github.com') {
    this.token = token;
    this.repo = repo;
    this.apiUrl = apiUrl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path.replace('{repo}', this.repo)}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /**
   * The log of the failed jobs in this workflow run, newest first. Used when no test report exists:
   * the job died before writing one, and its log is the only place the reason is written. Returns an
   * empty list when the token cannot read logs, which is not worth failing the run over.
   */
  async failedJobLogs(runId: string, limit = 2): Promise<Array<{ name: string; text: string }>> {
    try {
      const { jobs } = await this.request<{ jobs: Array<{ id: number; name: string; conclusion: string }> }>('GET', `/repos/{repo}/actions/runs/${runId}/jobs?per_page=100`);
      const failed = jobs.filter((j) => j.conclusion === 'failure').slice(0, limit);
      const out: Array<{ name: string; text: string }> = [];
      for (const job of failed) {
        // The logs endpoint answers with a redirect to a plain-text file, which fetch follows.
        const res = await fetch(`${this.apiUrl}/repos/${this.repo}/actions/jobs/${job.id}/logs`, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        });
        if (res.ok) out.push({ name: job.name, text: await res.text() });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Creates the PR comment carrying `marker`, or edits it in place so each PR has one. */
  async upsertComment(prNumber: number, marker: string, body: string): Promise<string> {
    const comments = await this.request<Array<{ id: number; body: string; html_url: string }>>('GET', `/repos/{repo}/issues/${prNumber}/comments?per_page=100`);
    const existing = comments.find((c) => c.body.includes(marker));
    const text = `${marker}\n${body}`;
    if (existing) return (await this.request<{ html_url: string }>('PATCH', `/repos/{repo}/issues/comments/${existing.id}`, { body: text })).html_url;
    return (await this.request<{ html_url: string }>('POST', `/repos/{repo}/issues/${prNumber}/comments`, { body: text })).html_url;
  }

  /**
   * One open issue per `marker` (e.g. environment failures): the first alert opens it, later
   * alerts are added as comments instead of new issues.
   */
  async upsertIssue(marker: string, title: string, body: string, update: string): Promise<IssueRef & { created: boolean }> {
    const open = await this.request<Array<IssueRef & { body: string | null; pull_request?: unknown }>>('GET', '/repos/{repo}/issues?state=open&per_page=100');
    const existing = open.find((i) => !i.pull_request && i.body?.includes(marker));
    if (existing) {
      await this.request('POST', `/repos/{repo}/issues/${existing.number}/comments`, { body: update });
      return { number: existing.number, html_url: existing.html_url, created: false };
    }
    const created = await this.request<IssueRef>('POST', '/repos/{repo}/issues', { title, body: `${marker}\n${body}` });
    return { ...created, created: true };
  }

  /** Opens a pull request from `head` into `base`, or updates the open one for the same head. */
  async upsertPullRequest(head: string, base: string, title: string, body: string): Promise<IssueRef> {
    const owner = this.repo.split('/')[0];
    const open = await this.request<IssueRef[]>('GET', `/repos/{repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    if (open[0]) return this.request<IssueRef>('PATCH', `/repos/{repo}/pulls/${open[0].number}`, { title, body });
    return this.request<IssueRef>('POST', '/repos/{repo}/pulls', { head, base, title, body });
  }
}
