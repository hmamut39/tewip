// Phase 13: GitLab. The same diagnosis Tewip posts on a GitHub pull request, posted as a note on a
// GitLab merge request - and edited in place on the next run rather than piling up.
//
// It only ever writes its own note: the note it edits must carry Tewip's marker, or a new one is
// created. It never approves, never merges, never resolves a discussion, and never touches a note
// somebody else wrote.
//
// Settings: TEWIP_GITLAB_TOKEN (a project access token with `api` scope). Inside GitLab CI the
// project, merge request and API URL come from the job's own variables.

export const GITLAB_MARKER = '<!-- tewip:report -->';

export interface GitLabConfig {
  apiUrl: string;
  projectId: string;
  token: string;
}

export function gitlabFromEnv(env: NodeJS.ProcessEnv = process.env): GitLabConfig | null {
  const apiUrl = (env.TEWIP_GITLAB_API ?? env.CI_API_V4_URL ?? '').trim().replace(/\/+$/, '');
  const projectId = (env.TEWIP_GITLAB_PROJECT ?? env.CI_PROJECT_ID ?? '').trim();
  // CI_JOB_TOKEN cannot post notes, so it is not accepted silently: a project access token is asked for.
  const token = (env.TEWIP_GITLAB_TOKEN ?? '').trim();
  return apiUrl && projectId && token ? { apiUrl, projectId, token } : null;
}

export function gitlabHelp(): string {
  return [
    'GitLab is not set up for comments. Inside GitLab CI only one setting is missing:',
    '  TEWIP_GITLAB_TOKEN=...   (Settings > Access tokens, role Reporter or above, scope "api")',
    'Outside GitLab CI, also set TEWIP_GITLAB_API=https://gitlab.com/api/v4 and TEWIP_GITLAB_PROJECT=<numeric project id>.',
    'Without it Tewip still writes the report to a file and to the job log.',
  ].join('\n');
}

export class GitLab {
  private readonly config: GitLabConfig;

  constructor(config: GitLabConfig) {
    this.config = config;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: { 'PRIVATE-TOKEN': this.config.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitLab ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private base(mergeRequest: string): string {
    return `/projects/${encodeURIComponent(this.config.projectId)}/merge_requests/${encodeURIComponent(mergeRequest)}`;
  }

  /** Tewip's own note on this merge request, if an earlier run left one. */
  async ownNote(mergeRequest: string): Promise<{ id: number } | null> {
    const notes = await this.request<Array<{ id: number; body: string; system: boolean }>>('GET', `${this.base(mergeRequest)}/notes?per_page=100&sort=desc`);
    return notes.find((n) => !n.system && n.body.includes(GITLAB_MARKER)) ?? null;
  }

  /**
   * Posts the report, or edits the note an earlier run left. Returns the note's web-visible id.
   * One note per merge request keeps a long review readable instead of a wall of robot comments.
   */
  async postReport(mergeRequest: string, body: string): Promise<number> {
    const withMarker = `${GITLAB_MARKER}\n${body}`;
    const existing = await this.ownNote(mergeRequest);
    if (existing) {
      await this.request('PUT', `${this.base(mergeRequest)}/notes/${existing.id}`, { body: withMarker });
      return existing.id;
    }
    const created = await this.request<{ id: number }>('POST', `${this.base(mergeRequest)}/notes`, { body: withMarker });
    return created.id;
  }
}
