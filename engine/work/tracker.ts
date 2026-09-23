// Teams do not all live in Jira. Some are in Rally, many are in GitHub Issues, and the ones that
// move between them do not want Tewip's promises to change with the tool.
//
// So the restraint lives here, above every tracker: Tewip creates items, comments on items it
// created itself, and finds what it filed before so it never files it twice. It never moves an item
// through a workflow, never assigns anyone, and never closes anything - in any tracker.
export type WorkItemKind = 'test-case' | 'bug' | 'story' | 'epic';

export interface NewWorkItem {
  kind: WorkItemKind;
  title: string;
  body: string;
  /** P0 | P1 | P2, translated to whatever the tracker calls it. */
  priority?: string;
  /** The epic or story this belongs under, when the tracker supports parents. */
  parent?: string;
  labels?: string[];
}

export interface ExistingWorkItem {
  /** What a person types to find it: PROJ-12, US1234, #87. */
  key: string;
  title: string;
  url?: string;
}

/**
 * What Tewip needs from a tracker, and nothing more. A tracker that cannot do one of these says so
 * by throwing; it never pretends.
 */
export interface Tracker {
  /** For the report: "Jira", "Rally", "GitHub Issues". */
  readonly name: string;
  /** Items Tewip filed before, found by the label or tag it puts on everything it creates. */
  mine(project: string, label: string): Promise<ExistingWorkItem[]>;
  /** Creates one item and returns its key. Nothing about it is ever changed afterwards. */
  create(project: string, item: NewWorkItem): Promise<string>;
  /** A note on an item Tewip itself created. */
  comment(key: string, text: string): Promise<void>;
  /** Whether this tracker can be written to at all with the settings given. */
  canWrite(): boolean;
}

export const TEWIP_LABEL = 'tewip';

/** Every tracker's own word for a priority, so a P0 does not arrive as "P0" in a tool that says "High". */
export const PRIORITY_WORDS: Record<string, Record<string, string>> = {
  jira: { P0: 'Highest', P1: 'High', P2: 'Medium' },
  rally: { P0: 'Resolve Immediately', P1: 'High Attention', P2: 'Normal' },
  github: { P0: 'priority:high', P1: 'priority:medium', P2: 'priority:low' },
};

export function priorityWord(tracker: string, priority: string): string {
  return PRIORITY_WORDS[tracker]?.[priority] ?? priority;
}

/** Which tracker the settings point at. Jira stays the default, because most teams are there. */
export function trackerNameFromEnv(env: NodeJS.ProcessEnv = process.env): 'jira' | 'rally' | 'github' {
  const named = (env.TEWIP_TRACKER ?? '').trim().toLowerCase();
  if (named === 'rally' || named === 'github' || named === 'jira') return named;
  if (env.TEWIP_RALLY_KEY) return 'rally';
  if (env.TEWIP_GITHUB_REPO && !env.TEWIP_JIRA_URL) return 'github';
  return 'jira';
}

export function trackerHelp(): string {
  return [
    'No tracker is set up. Tewip files work items into whichever of these you use:',
    '',
    '  Jira (Cloud, Server or Data Center)',
    '    TEWIP_JIRA_URL=https://your-team.atlassian.net   TEWIP_JIRA_EMAIL=you@company.com   TEWIP_JIRA_TOKEN=...',
    '',
    '  Rally (Broadcom, formerly CA Agile Central)',
    '    TEWIP_RALLY_KEY=_abc123...   TEWIP_RALLY_PROJECT=/project/12345   (TEWIP_RALLY_URL for on-premise)',
    '',
    '  GitHub Issues',
    '    TEWIP_GITHUB_REPO=owner/name   TEWIP_GITHUB_TOKEN=ghp_...  (or be logged in with the gh CLI)',
    '',
    'Set TEWIP_TRACKER=jira|rally|github when more than one is configured.',
  ].join('\n');
}
