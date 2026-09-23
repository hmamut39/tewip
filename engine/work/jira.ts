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

import { criteriaSection, wikiToText } from './wiki-text.ts';

export interface JiraConfig {
  baseUrl: string;
  /** Empty for a public tracker, which many projects run: then Tewip reads, and only reads. */
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
  if (!baseUrl) return null;
  const email = process.env.TEWIP_JIRA_EMAIL?.trim() ?? '';
  const token = process.env.TEWIP_JIRA_TOKEN?.trim() ?? '';
  // A tracker that anyone can read - Apache's, Jenkins', many company ones - needs no account at
  // all, and reading a ticket to plan from it is the commonest thing Tewip does with Jira.
  return { baseUrl, email, token };
}

export function jiraHelp(): string {
  return [
    'Jira is not set up. One setting to read a public tracker:',
    '  TEWIP_JIRA_URL=https://issues.apache.org/jira      (or your own Jira, Cloud or Server)',
    'Two more to let Tewip write test cases back into your own project:',
    '  TEWIP_JIRA_EMAIL=you@company.com',
    '  TEWIP_JIRA_TOKEN=...   (Cloud: id.atlassian.com/manage-profile/security/api-tokens;',
    '                          Server or Data Center: your profile > Personal Access Tokens)',
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

/**
 * A ticket as Tewip reads it, from the raw fields. Kept apart from the client so it can be checked
 * against real tickets without a network or an account.
 */
export function readIssue(raw: { key: string; fields: Record<string, unknown> }): JiraIssue {
  const fields = raw.fields;
  // Jira Cloud sends a document tree; Server and Data Center send wiki markup in a string.
  const description = (typeof fields.description === 'string' ? wikiToText(fields.description) : plainText(fields.description)).trim();
  // Some projects have a custom field for acceptance criteria; others put a heading in the body.
  const custom = Object.entries(fields).find(([name, value]) => /customfield/.test(name) && value && /acceptance/i.test(JSON.stringify(value).slice(0, 200)));
  const fromHeading = criteriaSection(description);
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

export class Jira {
  private readonly config: JiraConfig;
  /**
   * Cloud speaks /rest/api/3 and wants a document tree; Server and Data Center speak /rest/api/2
   * and want plain wiki markup. Most companies run the second kind, so both are supported: the
   * version is guessed from the address and corrected the first time the other one answers.
   */
  private version: 2 | 3;

  constructor(config: JiraConfig) {
    this.config = config;
    this.version = /atlassian\.net$/i.test(new URL(config.baseUrl).hostname) ? 3 : 2;
  }

  /** Whether this site turned out to be Cloud, for anything that has to send a description. */
  get isCloud(): boolean {
    return this.version === 3;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // No credentials means an anonymous read: the header is left off entirely, because an empty
    // one is rejected where no header at all is allowed.
    const auth: Record<string, string> = this.config.token ? { Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64')}` } : {};
    const send = async (version: 2 | 3) =>
      fetch(`${this.config.baseUrl}/rest/api/${version}${path}`, {
        method,
        headers: { ...auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) } as Record<string, string>,
        body: body ? JSON.stringify(this.bodyFor(version, body)) : undefined,
      });
    let res = await send(this.version);
    // The wrong guess answers 404 (no such endpoint) or 410 (gone); the other version is then tried
    // once and remembered, so a Server site does not pay for the guess on every call.
    if ((res.status === 404 || res.status === 410) && method === 'GET') {
      const other: 2 | 3 = this.version === 3 ? 2 : 3;
      const second = await send(other);
      if (second.ok) {
        this.version = other;
        res = second;
      }
    }
    if (!res.ok) throw new Error(`Jira ${method} /rest/api/${this.version}${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** A description is a document tree on Cloud and a string of wiki markup everywhere else. */
  private bodyFor(version: 2 | 3, body: unknown): unknown {
    const fields = (body as { fields?: { description?: unknown } }).fields;
    if (!fields || typeof fields.description !== 'string') return body;
    if (version === 2) return body;
    return { ...(body as object), fields: { ...fields, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(fields.description).slice(0, 30_000) }] }] } } };
  }

  /** One ticket, flattened into the facts a plan can be built from. */
  async issue(key: string): Promise<JiraIssue> {
    const raw = await this.request<{ key: string; fields: Record<string, unknown> }>('GET', `/issue/${encodeURIComponent(key)}`);
    return readIssue(raw);
  }

  /** The issue types a project actually has, so Tewip can pick one that exists rather than guess. */
  async issueTypes(projectKey: string): Promise<string[]> {
    const meta = await this.request<{ projects?: Array<{ issuetypes?: Array<{ name: string }> }> }>('GET', `/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`);
    return (meta.projects?.[0]?.issuetypes ?? []).map((t) => t.name);
  }

  /** Creates one issue and returns its key. Nothing else about it is ever changed afterwards. */
  async createIssue(input: { projectKey: string; type: string; summary: string; description: string; labels?: string[]; parentKey?: string }): Promise<string> {
    const created = await this.request<{ key: string }>('POST', '/issue', {
      fields: {
        project: { key: input.projectKey },
        issuetype: { name: input.type },
        summary: input.summary.slice(0, 250),
        description: input.description.slice(0, 30_000),
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
      },
    });
    return created.key;
  }

  /** Links a created issue to the ticket it came from, the only relationship Tewip makes. */
  async link(fromKey: string, toKey: string, type = 'Relates'): Promise<void> {
    await this.request('POST', '/issueLink', { type: { name: type }, inwardIssue: { key: fromKey }, outwardIssue: { key: toKey } });
  }

  /** Issues Tewip created before, so the same scenario is never filed twice. */
  async findByLabel(projectKey: string, label: string): Promise<Array<{ key: string; summary: string }>> {
    const jql = `project = ${projectKey} AND labels = ${label} ORDER BY created DESC`;
    const found = await this.request<{ issues?: Array<{ key: string; fields: { summary: string } }> }>('GET', `/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary`);
    return (found.issues ?? []).map((i) => ({ key: i.key, summary: i.fields.summary }));
  }
}
