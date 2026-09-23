// Two more places a team's work lives: Azure DevOps Boards and Linear. Each is one small class,
// because the promises already live above them in tracker.ts - create, comment on what Tewip
// created, find what it filed before, and never move, assign or close anything.
//
// Azure Boards: TEWIP_AZURE_ORG (the name in dev.azure.com/<org>), TEWIP_AZURE_PROJECT,
//   TEWIP_AZURE_TOKEN (a personal access token with Work Items: read & write).
// Linear: TEWIP_LINEAR_KEY (Settings > API > Personal API keys), TEWIP_LINEAR_TEAM (the team key,
//   e.g. ENG).
import type { ExistingWorkItem, NewWorkItem, Tracker, WorkItemKind } from './tracker.ts';

/* ------------------------------------------------------------------ Azure DevOps Boards */

export interface AzureConfig {
  org: string;
  project: string;
  token: string;
}

export function azureFromEnv(env: NodeJS.ProcessEnv = process.env): AzureConfig | null {
  const org = env.TEWIP_AZURE_ORG?.trim();
  const project = env.TEWIP_AZURE_PROJECT?.trim();
  if (!org || !project) return null;
  return { org, project, token: (env.TEWIP_AZURE_TOKEN ?? env.SYSTEM_ACCESSTOKEN ?? '').trim() };
}

/** Azure's own names for the kinds of work. A project template may not have all of them. */
const AZURE_TYPE: Record<WorkItemKind, string[]> = {
  'test-case': ['Test Case', 'Task'],
  bug: ['Bug', 'Issue'],
  story: ['User Story', 'Product Backlog Item', 'Issue'],
  epic: ['Epic', 'Feature'],
};

export class AzureBoards implements Tracker {
  readonly name = 'Azure Boards';
  private readonly config: AzureConfig;

  constructor(config: AzureConfig) {
    this.config = config;
  }

  canWrite(): boolean {
    return Boolean(this.config.token);
  }

  private headers(contentType = 'application/json'): Record<string, string> {
    // Azure takes the token as the password of a basic login with an empty user.
    return { Authorization: `Basic ${Buffer.from(`:${this.config.token}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': contentType };
  }

  private base(): string {
    return `https://dev.azure.com/${encodeURIComponent(this.config.org)}/${encodeURIComponent(this.config.project)}/_apis`;
  }

  private async request<T>(method: string, url: string, body?: unknown, contentType?: string): Promise<T> {
    const res = await fetch(url, { method, headers: this.headers(contentType), body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`Azure Boards ${method} ${url.replace(/\?.*/, '')} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Work items carrying Tewip's tag. Azure answers a query with ids, which are then read. */
  async mine(_project: string, label: string): Promise<ExistingWorkItem[]> {
    const wiql = { query: `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS '${label.replace(/'/g, "''")}'` };
    const found = await this.request<{ workItems?: Array<{ id: number }> }>('POST', `${this.base()}/wit/wiql?api-version=7.0`, wiql);
    const ids = (found.workItems ?? []).slice(0, 200).map((w) => w.id);
    if (ids.length === 0) return [];
    const items = await this.request<{ value?: Array<{ id: number; fields: Record<string, string> }> }>(
      'GET',
      `${this.base()}/wit/workitems?ids=${ids.join(',')}&fields=System.Title&api-version=7.0`,
    );
    return (items.value ?? []).map((i) => ({ key: String(i.id), title: i.fields['System.Title'] ?? '' }));
  }

  async create(_project: string, item: NewWorkItem): Promise<string> {
    // Azure creates a work item from a list of patch operations, not from an object.
    const type = AZURE_TYPE[item.kind][0];
    const patch: Array<Record<string, unknown>> = [
      { op: 'add', path: '/fields/System.Title', value: item.title.slice(0, 250) },
      { op: 'add', path: '/fields/System.Description', value: item.body.slice(0, 60_000).replace(/\n/g, '<br>') },
    ];
    if (item.labels?.length) patch.push({ op: 'add', path: '/fields/System.Tags', value: item.labels.join('; ') });
    const created = await this.request<{ id: number }>('POST', `${this.base()}/wit/workitems/$${encodeURIComponent(type)}?api-version=7.0`, patch, 'application/json-patch+json');
    return String(created.id);
  }

  async comment(key: string, text: string): Promise<void> {
    await this.request('POST', `${this.base()}/wit/workItems/${encodeURIComponent(key)}/comments?api-version=7.0-preview.3`, { text: text.slice(0, 60_000) });
  }
}

/* --------------------------------------------------------------------------------- Linear */

export interface LinearConfig {
  apiKey: string;
  /** The team key, e.g. ENG. */
  team: string;
}

export function linearFromEnv(env: NodeJS.ProcessEnv = process.env): LinearConfig | null {
  const apiKey = env.TEWIP_LINEAR_KEY?.trim();
  return apiKey ? { apiKey, team: (env.TEWIP_LINEAR_TEAM ?? '').trim() } : null;
}

export class Linear implements Tracker {
  readonly name = 'Linear';
  private readonly config: LinearConfig;
  private teamId: string | null = null;

  constructor(config: LinearConfig) {
    this.config = config;
  }

  canWrite(): boolean {
    return Boolean(this.config.apiKey && this.config.team);
  }

  /** Linear speaks GraphQL, and answers 200 with the errors inside the body. */
  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: this.config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(`Linear: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
    return body.data as T;
  }

  private async team(): Promise<string> {
    if (this.teamId) return this.teamId;
    const data = await this.graphql<{ teams: { nodes: Array<{ id: string; key: string }> } }>('query { teams(first: 50) { nodes { id key } } }');
    const found = data.teams.nodes.find((t) => t.key.toLowerCase() === this.config.team.toLowerCase());
    if (!found) throw new Error(`Linear has no team with the key "${this.config.team}". It has: ${data.teams.nodes.map((t) => t.key).join(', ')}`);
    this.teamId = found.id;
    return found.id;
  }

  async mine(_project: string, label: string): Promise<ExistingWorkItem[]> {
    const data = await this.graphql<{ issues: { nodes: Array<{ identifier: string; title: string; url: string }> } }>(
      'query($label: String!) { issues(first: 100, filter: { labels: { name: { eq: $label } } }) { nodes { identifier title url } } }',
      { label },
    );
    return data.issues.nodes.map((i) => ({ key: i.identifier, title: i.title, url: i.url }));
  }

  async create(_project: string, item: NewWorkItem): Promise<string> {
    const teamId = await this.team();
    const data = await this.graphql<{ issueCreate: { issue: { identifier: string } } }>(
      'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier } } }',
      { input: { teamId, title: item.title.slice(0, 250), description: item.body.slice(0, 60_000) } },
    );
    return data.issueCreate.issue.identifier;
  }

  async comment(key: string, text: string): Promise<void> {
    const found = await this.graphql<{ issue: { id: string } | null }>('query($id: String!) { issue(id: $id) { id } }', { id: key });
    if (!found.issue) throw new Error(`Linear has no issue ${key}`);
    await this.graphql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: found.issue.id, body: text.slice(0, 60_000) } });
  }
}
