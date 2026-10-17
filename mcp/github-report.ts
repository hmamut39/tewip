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

/**
 * Which of the artifact's reports to show, and in what order.
 *
 * This used to be two hard-coded names, `pr-comment.md` and `infra.md`, which are what the Action's
 * *triage* mode writes. Its **check** mode writes a different set - `checks.md`, `done.md`,
 * `schema.md`, `standards.md`, `vouch.md`, `access.md` - under the same artifact name, and both
 * modes were read by the same two lines. Found by running `tewip ci hmamut39/tewip` against Tewip's
 * own repository, whose self-check workflow runs in check mode: the artifact held 9KB of findings
 * across six files and the command printed **167 characters** - a title, a run link, and nothing
 * underneath. The answer to "why did CI fail on my PR?" was a URL.
 *
 * So the artifact decides what is shown, not this file. `pr-comment.md` leads when it exists because
 * it is the one written to be read by a person on a pull request; `infra.md` stays behind its ENV
 * count because it is about the machines rather than the change; everything else is named and shown.
 */
const LEADS = ['pr-comment.md', 'checks.md'];

export function reportsIn(files: Map<string, Buffer>, envCount: number): Array<{ name: string; body: string }> {
  const text = (name: string) => (files.get(name)?.toString('utf8') ?? '').trim();
  const names = [...files.keys()].filter((n) => n.endsWith('.md'));
  const ordered = [...LEADS.filter((n) => names.includes(n)), ...names.filter((n) => !LEADS.includes(n)).sort()];
  return ordered
    .filter((name) => (name === 'infra.md' ? envCount > 0 : true))
    .map((name) => ({ name, body: text(name) }))
    .filter((r) => r.body.length > 0);
}

/** A report's own heading if it has one, else its filename turned into words. */
const titleOf = (name: string): string => name.replace(/\.md$/, '').replace(/[-_]/g, ' ');

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
    const reports = reportsIn(files, envCount);
    // A header with nothing under it is the worst of the three possible answers here, because it
    // reads as "CI is fine" to anyone who does not know what the artifact was supposed to contain.
    const body =
      reports.length > 0
        ? reports.map((r, i) => (i === 0 && LEADS.includes(r.name) ? r.body : `## ${titleOf(r.name)}\n\n${r.body}`)).join('\n\n')
        : `This run's \`${artifact.name}\` artifact has nothing Tewip can show. It holds ${files.size === 0 ? 'no files' : `${files.size} file(s): ${[...files.keys()].sort().join(', ')}`}, and none of them has any content. The run itself is at ${found.run.html_url}.`;
    sections.push(
      [
        `# Tewip CI report: ${repo}, ${target}${suite ? ` - suite "${suite}"` : ''}`,
        `Run: ${bundle.runUrl ?? found.run.html_url} · commit \`${(bundle.sha ?? found.run.head_sha).slice(0, 8)}\` · generated ${bundle.generatedAt ?? artifact.created_at}${bundle.fixPr ? ` · verified fix PR: ${bundle.fixPr}` : ''}`,
        body,
      ].join('\n\n'),
    );
  }
  return cap(sections.join('\n\n---\n\n'));
}
