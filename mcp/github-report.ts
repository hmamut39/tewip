// Fetches the latest triage-agent report that the GitHub Action uploaded for a repository,
// pull request or branch, so an assistant can answer "why did CI fail on my PR?" without
// anyone opening the Actions page. Uses the gh CLI's login; read-only.
import { readZipBuffer } from '../engine/trace/zip.ts';
import { downloadArtifact, ghApi } from '../eval/harvest/gh.ts';
import { cap } from './tools.ts';

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number; head_branch: string; head_sha: string };
}

export async function githubCiReport(repo: string, pr?: number, branch?: string): Promise<string> {
  const head = pr ? (await ghApi<{ head: { ref: string } }>(`repos/${repo}/pulls/${pr}`)).head.ref : branch;
  // "triage-agent-report", or "triage-agent-report-<suite>" when a workflow triages several suites.
  const { artifacts } = await ghApi<{ artifacts: Artifact[] }>(`repos/${repo}/actions/artifacts?per_page=100`);
  const latest = artifacts
    .filter((a) => a.name.startsWith('triage-agent-report') && !a.expired && (!head || a.workflow_run?.head_branch === head))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const target = pr ? `PR #${pr} (${head})` : head ? `branch ${head}` : 'any branch';
  if (!latest) return `No triage-agent report for ${repo}, ${target}. Is the triage-agent action installed in that repository's CI workflow, and has it run since?`;

  const files = readZipBuffer(await downloadArtifact(repo, latest.id), (n) => n.endsWith('.md') || n === 'triage.json');
  const text = (name: string) => files.get(name)?.toString('utf8') ?? '';
  const bundle = JSON.parse(text('triage.json') || '{}') as { runUrl?: string; sha?: string; generatedAt?: string; items?: Array<{ diagnosis: { category: string } }>; fixPr?: string | null };
  const envCount = (bundle.items ?? []).filter((i) => i.diagnosis.category === 'ENV').length;

  return cap(
    [
      `# triage-agent CI report: ${repo}, ${target}`,
      `Run: ${bundle.runUrl ?? `workflow run ${latest.workflow_run?.id}`} · commit \`${(bundle.sha ?? latest.workflow_run?.head_sha ?? '').slice(0, 8)}\` · generated ${bundle.generatedAt ?? latest.created_at}${bundle.fixPr ? ` · verified fix PR: ${bundle.fixPr}` : ''}`,
      text('pr-comment.md'),
      envCount > 0 ? text('infra.md') : '',
    ]
      .filter(Boolean)
      .join('\n\n---\n\n'),
  );
}
