// Picking the tracker a team actually uses, and making Jira look like the others.
//
// Everything above this line in Tewip talks to `Tracker`, so adding Linear or Azure Boards later is
// one file and no changes anywhere else - and the promises (create, never move, never assign, never
// close, never file twice) hold for all of them by construction.
import { Jira, jiraFromEnv } from './jira.ts';
import { Rally, rallyFromEnv } from './rally.ts';
import { GitHubIssues, githubIssuesFromEnv } from './github-issues.ts';
import { AzureBoards, azureFromEnv, Linear, linearFromEnv } from './azure-linear.ts';
import { priorityWord, trackerHelp, trackerNameFromEnv, type ExistingWorkItem, type NewWorkItem, type Tracker } from './tracker.ts';

/** Jira, wearing the same interface as the rest. */
export class JiraTracker implements Tracker {
  readonly name = 'Jira';
  private readonly jira: Jira;
  private readonly hasToken: boolean;
  /** Issue types this project really has, read once. */
  private types: string[] | null = null;

  constructor(jira: Jira, hasToken: boolean) {
    this.jira = jira;
    this.hasToken = hasToken;
  }

  canWrite(): boolean {
    return this.hasToken;
  }

  async mine(project: string, label: string): Promise<ExistingWorkItem[]> {
    return (await this.jira.findByLabel(project, label)).map((i) => ({ key: i.key, title: i.summary }));
  }

  /** Jira projects differ in which types exist, so the nearest one that does is used. */
  private async typeFor(project: string, kind: NewWorkItem['kind']): Promise<string> {
    this.types ??= await this.jira.issueTypes(project);
    const wanted: Record<NewWorkItem['kind'], string[]> = {
      'test-case': ['Test', 'Test Case', 'Task'],
      bug: ['Bug', 'Defect', 'Task'],
      story: ['Story', 'User Story', 'Task'],
      epic: ['Epic', 'Feature', 'Task'],
    };
    const found = wanted[kind].find((t) => this.types!.includes(t)) ?? this.types![0];
    if (!found) throw new Error(`no issue type available in ${project}`);
    return found;
  }

  async create(project: string, item: NewWorkItem): Promise<string> {
    return this.jira.createIssue({
      projectKey: project,
      type: await this.typeFor(project, item.kind),
      summary: item.title,
      description: item.body,
      labels: item.labels,
      parentKey: item.parent,
    });
  }

  async comment(key: string, text: string): Promise<void> {
    await this.jira.comment(key, text);
  }
}

export interface ChosenTracker {
  tracker: Tracker;
  /** The project, board or repository items go into. */
  project: string;
  /** Which one it is, for priority words and messages. */
  id: 'jira' | 'rally' | 'github' | 'azure' | 'linear';
}

/**
 * The tracker the settings point at, or null when none is configured. A tracker that can only be
 * read (a public Jira, or GitHub without a token) still comes back: a dry run needs no write.
 */
export function trackerFromEnv(projectKey = '', env: NodeJS.ProcessEnv = process.env): ChosenTracker | null {
  const id = trackerNameFromEnv(env);
  if (id === 'rally') {
    const config = rallyFromEnv(env);
    return config ? { tracker: new Rally(config), project: projectKey || config.project, id } : null;
  }
  if (id === 'github') {
    const config = githubIssuesFromEnv(env);
    return config ? { tracker: new GitHubIssues(config), project: projectKey || config.repo, id } : null;
  }
  if (id === 'azure') {
    const config = azureFromEnv(env);
    return config ? { tracker: new AzureBoards(config), project: projectKey || config.project, id } : null;
  }
  if (id === 'linear') {
    const config = linearFromEnv(env);
    return config ? { tracker: new Linear(config), project: projectKey || config.team, id } : null;
  }
  const config = jiraFromEnv();
  return config ? { tracker: new JiraTracker(new Jira(config), Boolean(config.token)), project: projectKey, id } : null;
}

export { priorityWord, trackerHelp };
export type { NewWorkItem, Tracker };
