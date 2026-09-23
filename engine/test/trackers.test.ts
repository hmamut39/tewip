// Three trackers, one set of promises. What is tested here is that the promises do not change with
// the tool: create, comment only on what Tewip created, find what it filed before, and never move,
// assign or close anything - in Jira, in Rally and in GitHub Issues alike.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Rally, rallyFromEnv } from '../work/rally.ts';
import { GitHubIssues, githubIssuesFromEnv } from '../work/github-issues.ts';
import { priorityWord, trackerHelp, trackerNameFromEnv } from '../work/tracker.ts';
import { trackerFromEnv } from '../work/trackers.ts';
import { AzureBoards, Linear, azureFromEnv, linearFromEnv } from '../work/azure-linear.ts';

interface Call {
  method: string;
  url: string;
  body?: any;
}

/** Records what a tracker asked for, and answers the way the real service does. */
function record(answer: (url: string, method: string) => unknown) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => answer(String(url), method), text: async () => '' };
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const saved: Record<string, string | undefined> = {};
const withEnv = (values: Record<string, string>) => {
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe('choosing the tracker a team uses', () => {
  it('reads the settings, and defaults to Jira because most teams are there', () => {
    assert.equal(trackerNameFromEnv({ TEWIP_RALLY_KEY: '_abc' } as NodeJS.ProcessEnv), 'rally');
    assert.equal(trackerNameFromEnv({ TEWIP_GITHUB_REPO: 'team/app' } as NodeJS.ProcessEnv), 'github');
    assert.equal(trackerNameFromEnv({ TEWIP_JIRA_URL: 'https://x.atlassian.net' } as NodeJS.ProcessEnv), 'jira');
    assert.equal(trackerNameFromEnv({} as NodeJS.ProcessEnv), 'jira');
    assert.equal(trackerNameFromEnv({ TEWIP_LINEAR_KEY: 'lin_api_x' } as NodeJS.ProcessEnv), 'linear');
    assert.equal(trackerNameFromEnv({ TEWIP_AZURE_ORG: 'acme', TEWIP_AZURE_PROJECT: 'shop' } as NodeJS.ProcessEnv), 'azure');
    assert.equal(trackerNameFromEnv({ TEWIP_TRACKER: 'github', TEWIP_RALLY_KEY: '_abc' } as NodeJS.ProcessEnv), 'github', 'a named tracker wins');
  });

  it('says how to set each one up rather than failing silently', () => {
    const help = trackerHelp();
    for (const word of ['Jira', 'Rally', 'GitHub Issues', 'TEWIP_RALLY_KEY', 'TEWIP_GITHUB_REPO']) assert.match(help, new RegExp(word));
  });

  it('speaks each tracker\'s own word for a priority', () => {
    assert.equal(priorityWord('jira', 'P0'), 'Highest');
    assert.equal(priorityWord('rally', 'P0'), 'Resolve Immediately');
    assert.equal(priorityWord('github', 'P1'), 'priority:medium');
    assert.equal(priorityWord('jira', 'P9'), 'P9', 'an unknown priority is passed through, not invented');
  });

  it('comes back for a public tracker that can be read but not written', () => {
    withEnv({ TEWIP_JIRA_URL: 'https://issues.apache.org/jira', TEWIP_JIRA_EMAIL: '', TEWIP_JIRA_TOKEN: '' });
    const chosen = trackerFromEnv('KAFKA');
    assert.equal(chosen?.tracker.name, 'Jira');
    assert.equal(chosen?.tracker.canWrite(), false, 'a dry run still works; writing does not');
  });
});

describe('Rally', () => {
  const config = { baseUrl: 'https://rally1.rallydev.com', apiKey: '_key', project: '/project/12345' };

  it('creates each kind of work under the name Rally gives it', async () => {
    const http = record(() => ({ CreateResult: { Object: { FormattedID: 'TC42' }, Errors: [] } }));
    try {
      const rally = new Rally(config);
      const key = await rally.create('/project/12345', { kind: 'test-case', title: 'search finds a word', body: 'steps', priority: 'P1' });
      assert.equal(key, 'TC42');
      const [call] = http.calls;
      assert.match(call.url, /\/slm\/webservice\/v2\.0\/testcase\/create$/);
      assert.equal(call.body.Testcase.Name, 'search finds a word');
      assert.equal(call.body.Testcase.Project, '/project/12345');
    } finally {
      http.restore();
    }
  });

  it('reads the errors Rally hides inside a 200 answer', async () => {
    const http = record(() => ({ CreateResult: { Errors: ['Could not read: project not found'] } }));
    try {
      await assert.rejects(() => new Rally(config).create('/project/1', { kind: 'bug', title: 'x', body: 'y' }), /project not found/);
    } finally {
      http.restore();
    }
  });

  it('finds what it filed before by its tag, across every kind', async () => {
    const http = record(() => ({ QueryResult: { Results: [{ FormattedID: 'DE7', Name: 'checkout charges twice' }], Errors: [] } }));
    try {
      const mine = await new Rally(config).mine('/project/12345', 'tewip');
      assert.ok(mine.some((i) => i.key === 'DE7'));
      assert.ok(http.calls.every((c) => c.method === 'GET'), 'finding is only ever a read');
      assert.ok(http.calls.some((c) => c.url.includes('testcase?')) && http.calls.some((c) => c.url.includes('defect?')));
    } finally {
      http.restore();
    }
  });

  it('needs a project before it will write anything', () => {
    assert.equal(new Rally({ ...config, project: '' }).canWrite(), false);
    assert.equal(rallyFromEnv({ TEWIP_RALLY_KEY: '_k', TEWIP_RALLY_PROJECT: '/project/9' } as NodeJS.ProcessEnv)?.project, '/project/9');
    assert.equal(rallyFromEnv({} as NodeJS.ProcessEnv), null);
  });
});

describe('GitHub Issues', () => {
  const config = { repo: 'team/app', token: 'ghp_x' };

  it('opens an issue with the kind and priority as labels', async () => {
    const http = record(() => ({ number: 87 }));
    try {
      const key = await new GitHubIssues(config).create('team/app', { kind: 'bug', title: 'checkout charges twice', body: 'evidence', priority: 'P0', labels: ['tewip'] });
      assert.equal(key, '#87');
      const [call] = http.calls;
      assert.match(call.url, /api\.github\.com\/repos\/team\/app\/issues$/);
      assert.deepEqual(call.body.labels.sort(), ['bug', 'priority:p0', 'tewip']);
    } finally {
      http.restore();
    }
  });

  it('counts closed issues as already filed, so nothing is filed twice', async () => {
    const http = record(() => [{ number: 12, title: 'checkout charges twice', html_url: 'https://github.com/team/app/issues/12' }]);
    try {
      const mine = await new GitHubIssues(config).mine('team/app', 'tewip-bug');
      assert.deepEqual(mine[0], { key: '#12', title: 'checkout charges twice', url: 'https://github.com/team/app/issues/12' });
      assert.match(http.calls[0].url, /state=all/);
    } finally {
      http.restore();
    }
  });

  it('takes the repository from the CI environment when it is not set by hand', () => {
    assert.equal(githubIssuesFromEnv({ GITHUB_REPOSITORY: 'team/app', GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv)?.repo, 'team/app');
    assert.equal(githubIssuesFromEnv({} as NodeJS.ProcessEnv), null);
  });
});

describe('Azure Boards', () => {
  const config = { org: 'acme', project: 'shop', token: 'pat' };

  it('creates a work item the way Azure wants it: a list of patch operations', async () => {
    const http = record(() => ({ id: 412 }));
    try {
      const key = await new AzureBoards(config).create('shop', { kind: 'bug', title: 'checkout charges twice', body: 'line one', labels: ['tewip'] });
      assert.equal(key, '412');
      const [call] = http.calls;
      assert.match(call.url, /dev\.azure\.com\/acme\/shop\/_apis\/wit\/workitems\/\$Bug/);
      assert.deepEqual(call.body[0], { op: 'add', path: '/fields/System.Title', value: 'checkout charges twice' });
      assert.ok(call.body.some((op: any) => op.path === '/fields/System.Tags' && op.value === 'tewip'));
    } finally {
      http.restore();
    }
  });

  it('finds what it filed before by querying its tag', async () => {
    const http = record((url) => (url.includes('wiql') ? { workItems: [{ id: 7 }] } : { value: [{ id: 7, fields: { 'System.Title': 'checkout charges twice' } }] }));
    try {
      const mine = await new AzureBoards(config).mine('shop', 'tewip-bug');
      assert.deepEqual(mine, [{ key: '7', title: 'checkout charges twice' }]);
      assert.match(http.calls[0].body.query, /System\.Tags\] CONTAINS 'tewip-bug'/);
    } finally {
      http.restore();
    }
  });

  it('needs a token before it will write', () => {
    assert.equal(new AzureBoards({ ...config, token: '' }).canWrite(), false);
    assert.equal(azureFromEnv({ TEWIP_AZURE_ORG: 'acme' } as NodeJS.ProcessEnv), null, 'a project is required too');
  });
});

describe('Linear', () => {
  const config = { apiKey: 'lin_api_x', team: 'ENG' };

  it('looks the team up by its key, then creates the issue', async () => {
    const http = record((_url, _method) => ({ data: { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] }, issueCreate: { issue: { identifier: 'ENG-42' } } } }));
    try {
      const key = await new Linear(config).create('ENG', { kind: 'bug', title: 'checkout charges twice', body: 'evidence' });
      assert.equal(key, 'ENG-42');
      assert.equal(http.calls.length, 2, 'one lookup, one creation');
      assert.match(http.calls[1].body.query, /issueCreate/);
      assert.equal(http.calls[1].body.variables.input.teamId, 'team-1');
    } finally {
      http.restore();
    }
  });

  it('says which teams exist when the key is wrong, instead of failing blankly', async () => {
    const http = record(() => ({ data: { teams: { nodes: [{ id: 't', key: 'OPS' }] } } }));
    try {
      await assert.rejects(() => new Linear({ apiKey: 'k', team: 'ENG' }).create('ENG', { kind: 'bug', title: 'x', body: 'y' }), /no team with the key "ENG".*OPS/s);
    } finally {
      http.restore();
    }
  });

  it('reads the errors Linear returns inside a 200 answer', async () => {
    const http = record(() => ({ errors: [{ message: 'Authentication required' }] }));
    try {
      await assert.rejects(() => new Linear(config).mine('ENG', 'tewip'), /Authentication required/);
    } finally {
      http.restore();
    }
  });

  it('needs a team before it will write', () => {
    assert.equal(new Linear({ apiKey: 'k', team: '' }).canWrite(), false);
    assert.equal(linearFromEnv({} as NodeJS.ProcessEnv), null);
  });
});

describe('what no tracker may do', () => {
  it('never asks any of them to move, assign or close anything', async () => {
    const http = record((url) => (url.includes('issues?') ? [] : { CreateResult: { Object: { FormattedID: 'X1' }, Errors: [] }, QueryResult: { Results: [], Errors: [] }, number: 1 }));
    try {
      const rally = new Rally({ baseUrl: 'https://rally1.rallydev.com', apiKey: '_k', project: '/project/1' });
      await rally.create('/project/1', { kind: 'bug', title: 'a', body: 'b' });
      await rally.comment('/defect/1', 'seen again');
      await rally.mine('/project/1', 'tewip');
      const gh = new GitHubIssues({ repo: 'team/app', token: 't' });
      await gh.create('team/app', { kind: 'bug', title: 'a', body: 'b' });
      await gh.comment('#1', 'seen again');
      await gh.mine('team/app', 'tewip');
      const azure = new AzureBoards({ org: 'acme', project: 'shop', token: 't' });
      await azure.create('shop', { kind: 'bug', title: 'a', body: 'b' });
      await azure.comment('7', 'seen again');

      const forbidden = http.calls.filter((c) => /transitions|assignee|\/state|close/i.test(c.url) || c.method === 'PUT' || c.method === 'PATCH' || c.method === 'DELETE');
      assert.deepEqual(forbidden, [], 'the board belongs to the team, whichever board it is');
    } finally {
      http.restore();
    }
  });
});
