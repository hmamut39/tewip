// Phase 10: the work item loop. Tewip's plans and diagnoses are useful only where a team already
// works, and for most teams that is Jira. This reads a ticket so a plan can be grounded in what was
// actually asked for, and writes test cases and bugs back.
//
// What it will never do, enforced here rather than promised in a document: move a ticket through a
// workflow, assign anyone, close anything, or comment on a ticket it did not create. Writing is a
// suggestion; the board belongs to the team.
//
// Settings: TEWIP_JIRA_URL (https://your-team.atlassian.net), TEWIP_JIRA_EMAIL, TEWIP_JIRA_TOKEN
// (an API token from id.atlassian.com).

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  /** The description as plain text, with Atlassian's document format flattened. */
  description: string;
  /** Acceptance criteria, when the project keeps them in a field or in the description. */
  acceptanceCriteria: string;
  type: string;
  status: string;
  labels: string[];
  /** Any Figma links found in the ticket, for Phase 11. */
  designLinks: string[];
}

/** The configuration from the environment, or null when Jira is not set up. */
export function jiraFromEnv(): JiraConfig | null {
  const baseUrl = process.env.TEWIP_JIRA_URL?.trim().replace(/\/+$/, '');
  const email = process.env.TEWIP_JIRA_EMAIL?.trim();
  const token = process.env.TEWIP_JIRA_TOKEN?.trim();
  return baseUrl && email && token ? { baseUrl, email, token } : null;
}

export function jiraHelp(): string {
  return [
    'Jira is not set up. Three settings, all from your own account:',
    '  TEWIP_JIRA_URL=https://your-team.atlassian.net',
    '  TEWIP_JIRA_EMAIL=you@company.com',
    '  TEWIP_JIRA_TOKEN=...   (create one at id.atlassian.com/manage-profile/security/api-tokens)',
  ].join('\n');
}

/** Atlassian's document format is a tree of nodes; this takes the words out of it. */
export function plainText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.text) return n.text;
  const inner = (n.content ?? []).map(plainText).join(n.type === 'paragraph' || n.type === 'listItem' ? '' : '');
  return n.type === 'paragraph' || n.type === 'listItem' || n.type === 'heading' ? `${inner}\n` : inner;
}

const FIGMA_LINK = /https:\/\/(?:www\.)?figma\.com\/[^\s)"']+/g;
/** Teams keep acceptance criteria under many headings; these are the common ones. */
const CRITERIA_HEADING = /(?:^|\n)\s*(?:acceptance criteria|ac|definition of done|dod)\s*:?\s*\n/i;

export class Jira {
  private readonly config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = config;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64');
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Jira ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** One ticket, flattened into the facts a plan can be built from. */
  async issue(key: string): Promise<JiraIssue> {
    const raw = await this.request<{ key: string; fields: Record<string, unknown> }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}`);
    const fields = raw.fields;
    const description = plainText(fields.description).trim();
    // Some projects have a custom field for acceptance criteria; others put a heading in the body.
    const custom = Object.entries(fields).find(([name, value]) => /customfield/.test(name) && value && /acceptance/i.test(JSON.stringify(value).slice(0, 200)));
    const fromHeading = CRITERIA_HEADING.test(description) ? description.split(CRITERIA_HEADING).slice(1).join('\n').trim() : '';
    return {
      key: raw.key,
      summary: String((fields.summary as string) ?? ''),
      description,
      acceptanceCriteria: fromHeading || (custom ? plainText(custom[1]).trim() : ''),
      type: String(((fields.issuetype as { name?: string }) ?? {}).name ?? ''),
      status: String(((fields.status as { name?: string }) ?? {}).name ?? ''),
      labels: (fields.labels as string[]) ?? [],
      designLinks: [...new Set(`${description} ${JSON.stringify(fields.attachment ?? '')}`.match(FIGMA_LINK) ?? [])],
    };
  }

  /** The issue types a project actually has, so Tewip can pick one that exists rather than guess. */
  async issueTypes(projectKey: string): Promise<string[]> {
    const meta = await this.request<{ projects?: Array<{ issuetypes?: Array<{ name: string }> }> }>('GET', `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}`);
    return (meta.projects?.[0]?.issuetypes ?? []).map((t) => t.name);
  }

  /** Creates one issue and returns its key. Nothing else about it is ever changed afterwards. */
  async createIssue(input: { projectKey: string; type: string; summary: string; description: string; labels?: string[]; parentKey?: string }): Promise<string> {
    const created = await this.request<{ key: string }>('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: input.projectKey },
        issuetype: { name: input.type },
        summary: input.summary.slice(0, 250),
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: input.description.slice(0, 30_000) }] }] },
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
      },
    });
    return created.key;
  }

  /** Links a created issue to the ticket it came from, the only relationship Tewip makes. */
  async link(fromKey: string, toKey: string, type = 'Relates'): Promise<void> {
    await this.request('POST', '/rest/api/3/issueLink', { type: { name: type }, inwardIssue: { key: fromKey }, outwardIssue: { key: toKey } });
  }

  /** Issues Tewip created before, so the same scenario is never filed twice. */
  async findByLabel(projectKey: string, label: string): Promise<Array<{ key: string; summary: string }>> {
    const jql = `project = ${projectKey} AND labels = ${label} ORDER BY created DESC`;
    const found = await this.request<{ issues?: Array<{ key: string; fields: { summary: string } }> }>('GET', `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary`);
    return (found.issues ?? []).map((i) => ({ key: i.key, summary: i.fields.summary }));
  }
}
