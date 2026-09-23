// GitHub Issues, for the many teams whose backlog is simply their repository.
//
// It uses the token in the environment, or the `gh` CLI login the person already has, so a team on
// GitHub needs no new account and no new secret. The restraint is the same: create, comment on what
// it created, find what it filed before by its label. It never closes an issue, never assigns
// anyone, and never touches an issue somebody else opened.
import { spawnSync } from 'node:child_process';
import type { ExistingWorkItem, NewWorkItem, Tracker } from './tracker.ts';

export interface GitHubIssuesConfig {
  /** owner/name */
  repo: string;
  token: string;
}

export function githubIssuesFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubIssuesConfig | null {
  const repo = (env.TEWIP_GITHUB_REPO ?? env.GITHUB_REPOSITORY ?? '').trim();
  if (!repo) return null;
  return { repo, token: (env.TEWIP_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '').trim() || ghCliToken() };
}

/** The token the `gh` CLI already holds, so a person logged in there needs nothing else. */
function ghCliToken(): string {
  const r = spawnSync('gh auth token', { shell: true, encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

/** The kind of work is a label here: GitHub has one issue type and many labels. */
const KIND_LABEL: Record<NewWorkItem['kind'], string> = { 'test-case': 'test-case', bug: 'bug', story: 'story', epic: 'epic' };

export class GitHubIssues implements Tracker {
  readonly name = 'GitHub Issues';
  private readonly config: GitHubIssuesConfig;

  constructor(config: GitHubIssuesConfig) {
    this.config = config;
  }

  canWrite(): boolean {
    return Boolean(this.config.repo && this.config.token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tewip',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async mine(_project: string, label: string): Promise<ExistingWorkItem[]> {
    // Closed ones count too: an issue Tewip filed and a person closed must not be filed again.
    const issues = await this.request<Array<{ number: number; title: string; html_url: string }>>(
      'GET',
      `/repos/${this.config.repo}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`,
    );
    return issues.map((i) => ({ key: `#${i.number}`, title: i.title, url: i.html_url }));
  }

  async create(_project: string, item: NewWorkItem): Promise<string> {
    const created = await this.request<{ number: number }>('POST', `/repos/${this.config.repo}/issues`, {
      title: item.title.slice(0, 250),
      body: item.body.slice(0, 60_000),
      labels: [...new Set([...(item.labels ?? []), KIND_LABEL[item.kind], ...(item.priority ? [`priority:${item.priority.toLowerCase()}`] : [])])],
    });
    return `#${created.number}`;
  }

  async comment(key: string, text: string): Promise<void> {
    const number = key.replace('#', '');
    await this.request('POST', `/repos/${this.config.repo}/issues/${number}/comments`, { body: text.slice(0, 60_000) });
  }
}
