// Rally (Broadcom, formerly CA Agile Central), through its Web Services API v2.0.
//
// Rally names things differently from everyone else: a user story is a HierarchicalRequirement, a
// test case is a TestCase, a bug is a Defect, and everything is addressed by a reference like
// /project/12345. The restraint is the same as everywhere else: create, comment on what it created,
// never move, never assign, never close.
//
// Settings: TEWIP_RALLY_KEY (an API key from rally1.rallydev.com > Settings > API Keys),
// TEWIP_RALLY_PROJECT (/project/12345, from the URL of your project), and TEWIP_RALLY_URL for an
// on-premise server.
import type { ExistingWorkItem, NewWorkItem, Tracker, WorkItemKind } from './tracker.ts';
import { priorityWord } from './tracker.ts';

export interface RallyConfig {
  baseUrl: string;
  apiKey: string;
  /** /project/12345 */
  project: string;
}

/** Rally's own name for each kind of item, and the endpoint that creates it. */
const TYPE: Record<WorkItemKind, string> = {
  'test-case': 'testcase',
  bug: 'defect',
  story: 'hierarchicalrequirement',
  epic: 'portfolioitem/feature',
};

/** The field that holds the words, which differs by type. */
const BODY_FIELD: Record<WorkItemKind, string> = { 'test-case': 'Description', bug: 'Description', story: 'Description', epic: 'Description' };

export function rallyFromEnv(env: NodeJS.ProcessEnv = process.env): RallyConfig | null {
  const apiKey = env.TEWIP_RALLY_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: (env.TEWIP_RALLY_URL ?? 'https://rally1.rallydev.com').trim().replace(/\/+$/, ''),
    apiKey,
    project: (env.TEWIP_RALLY_PROJECT ?? '').trim(),
  };
}

export class Rally implements Tracker {
  readonly name = 'Rally';
  private readonly config: RallyConfig;

  constructor(config: RallyConfig) {
    this.config = config;
  }

  canWrite(): boolean {
    return Boolean(this.config.apiKey && this.config.project);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}/slm/webservice/v2.0${path}`, {
      method,
      headers: { ZSESSIONID: this.config.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Rally ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as any;
    // Rally answers 200 with the errors inside the body, so they have to be read out of it.
    const errors = json?.CreateResult?.Errors ?? json?.QueryResult?.Errors ?? json?.OperationResult?.Errors ?? [];
    if (errors.length > 0) throw new Error(`Rally ${method} ${path}: ${errors.join('; ').slice(0, 300)}`);
    return json as T;
  }

  /** Items Tewip filed before, found by the tag it puts on everything it creates. */
  async mine(project: string, label: string): Promise<ExistingWorkItem[]> {
    const found: ExistingWorkItem[] = [];
    for (const kind of ['testcase', 'defect', 'hierarchicalrequirement']) {
      const query = encodeURIComponent(`(Tags.Name = "${label}")`);
      const scope = project || this.config.project;
      const path = `/${kind}?query=${query}&fetch=FormattedID,Name&pagesize=200${scope ? `&project=${encodeURIComponent(scope)}` : ''}`;
      try {
        const body = await this.request<{ QueryResult?: { Results?: Array<{ FormattedID?: string; Name?: string; _ref?: string }> } }>('GET', path);
        for (const r of body.QueryResult?.Results ?? []) found.push({ key: String(r.FormattedID ?? r._ref ?? ''), title: String(r.Name ?? ''), url: r._ref });
      } catch {
        // A workspace without that type is normal; the others still answer.
      }
    }
    return found;
  }

  async create(project: string, item: NewWorkItem): Promise<string> {
    const type = TYPE[item.kind];
    const fields: Record<string, unknown> = {
      Name: item.title.slice(0, 250),
      [BODY_FIELD[item.kind]]: item.body.slice(0, 32_000),
      Project: project || this.config.project,
    };
    if (item.priority) fields[item.kind === 'bug' ? 'Priority' : 'Risk'] = priorityWord('rally', item.priority);
    if (item.parent) fields[item.kind === 'story' ? 'PortfolioItem' : 'WorkProduct'] = item.parent;
    const key = type.split('/')[0];
    const created = await this.request<{ CreateResult?: { Object?: { FormattedID?: string; _ref?: string } } }>('POST', `/${type}/create`, { [capitalise(key)]: fields });
    const made = created.CreateResult?.Object;
    return String(made?.FormattedID ?? made?._ref ?? '');
  }

  /** A note on an item Tewip created. Rally calls it a ConversationPost. */
  async comment(key: string, text: string): Promise<void> {
    await this.request('POST', '/conversationpost/create', { ConversationPost: { Artifact: key, Text: text.slice(0, 4000) } });
  }
}

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
