// Fetches the latest Tewip report that the GitHub Action uploaded for a repository,
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
}

interface WorkflowRun {
  id: number;
  head_branch: string;
  head_sha: string;
  html_url: string;
}

/** "tewip-report" or "tewip-report-<suite>"; "triage-agent-report" is what versions before the rename uploaded. */
const REPORT = /^(?:tewip|triage-agent)-report(-.+)?$/;
/** How many recent runs to look through for one that uploaded a report. */
const RUNS_TO_SEARCH = 30;

/**
 * The newest workflow run on the branch that uploaded Tewip reports, and those reports.
 * Looked up run by run rather than across all of a repository's artifacts, which in a busy
 * repository are mostly other workflows' and would push the report out of the first page.
 */
async function latestReports(repo: string, branch: string | undefined): Promise<{ run: WorkflowRun; artifacts: Artifact[] } | null> {
  const query = `per_page=${RUNS_TO_SEARCH}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
  const { workflow_runs: runs } = await ghApi<{ workflow_runs: WorkflowRun[] }>(`repos/${repo}/actions/runs?${query}`);
  for (const run of runs) {
    const { artifacts } = await ghApi<{ artifacts: Artifact[] }>(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    const reports = artifacts.filter((a) => REPORT.test(a.name) && !a.expired);
    if (reports.length > 0) return { run, artifacts: reports.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  return null;
}

export async function githubCiReport(repo: string, pr?: number, branch?: string): Promise<string> {
  const head = pr ? (await ghApi<{ head: { ref: string } }>(`repos/${repo}/pulls/${pr}`)).head.ref : branch;
  const target = pr ? `PR #${pr} (${head})` : head ? `branch ${head}` : 'any branch';
  const found = await latestReports(repo, head);
  if (!found) return `No Tewip report for ${repo}, ${target} in its last ${RUNS_TO_SEARCH} workflow runs. Is the Tewip action installed in that repository's CI workflow, and has it run since?`;

  const sections: string[] = [];
  for (const artifact of found.artifacts) {
    const files = readZipBuffer(await downloadArtifact(repo, artifact.id), (n) => n.endsWith('.md') || n === 'triage.json');
    const text = (name: string) => files.get(name)?.toString('utf8') ?? '';
    const bundle = JSON.parse(text('triage.json') || '{}') as { runUrl?: string; sha?: string; generatedAt?: string; items?: Array<{ diagnosis: { category: string } }>; fixPr?: string | null };
    const envCount = (bundle.items ?? []).filter((i) => i.diagnosis.category === 'ENV').length;
    const suite = artifact.name.replace(/^(?:tewip|triage-agent)-report-?/, '');
    sections.push(
      [
        `# Tewip CI report: ${repo}, ${target}${suite ? ` - suite "${suite}"` : ''}`,
        `Run: ${bundle.runUrl ?? found.run.html_url} · commit \`${(bundle.sha ?? found.run.head_sha).slice(0, 8)}\` · generated ${bundle.generatedAt ?? artifact.created_at}${bundle.fixPr ? ` · verified fix PR: ${bundle.fixPr}` : ''}`,
        text('pr-comment.md'),
        envCount > 0 ? text('infra.md') : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  return cap(sections.join('\n\n---\n\n'));
}
