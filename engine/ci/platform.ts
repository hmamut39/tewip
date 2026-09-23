// Phase 13: Tewip's engine never cared which CI it runs in, but its edges did. This reads the facts
// every CI provides - which project, which branch, which commit, which merge request, where the run
// can be seen - out of whatever platform is actually running, so one command works in GitHub
// Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines, Bitbucket, Travis, Drone or nothing.
//
// The variable names below are each platform's own documented ones; nothing is guessed.

export type PlatformId = 'github' | 'gitlab' | 'jenkins' | 'circleci' | 'azure' | 'bitbucket' | 'travis' | 'drone' | 'local';

export interface CiFacts {
  platform: PlatformId;
  /** How to say it in a report: "GitLab CI", "Jenkins". */
  label: string;
  /** owner/name, or the project path; '' when the platform does not say. */
  project: string;
  branch: string;
  sha: string;
  /** The merge or pull request number, when the run belongs to one. */
  changeRequest: string;
  /** A link to this run, for the footer of every report. */
  runUrl: string;
  /** A name for the run, used as the id in the report. */
  runId: string;
}

const first = (env: NodeJS.ProcessEnv, ...names: string[]): string => {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return '';
};

const shortBranch = (ref: string): string => ref.replace(/^refs\/(?:heads|tags)\//, '');

/** Which CI this is, read from the variables that CI sets for every job. */
export function detectPlatform(env: NodeJS.ProcessEnv = process.env): PlatformId {
  if (env.GITHUB_ACTIONS === 'true' || env.GITHUB_RUN_ID) return 'github';
  if (env.GITLAB_CI === 'true' || env.CI_PROJECT_ID) return 'gitlab';
  if (env.JENKINS_URL || env.BUILD_NUMBER) return 'jenkins';
  if (env.CIRCLECI === 'true') return 'circleci';
  if (env.TF_BUILD === 'True' || env.TF_BUILD === 'true') return 'azure';
  if (env.BITBUCKET_BUILD_NUMBER) return 'bitbucket';
  if (env.TRAVIS === 'true') return 'travis';
  if (env.DRONE === 'true') return 'drone';
  return 'local';
}

const LABELS: Record<PlatformId, string> = {
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  jenkins: 'Jenkins',
  circleci: 'CircleCI',
  azure: 'Azure Pipelines',
  bitbucket: 'Bitbucket Pipelines',
  travis: 'Travis CI',
  drone: 'Drone',
  local: 'this machine',
};

/** Everything Tewip needs to write a report, from whichever CI is running. */
export function ciFacts(env: NodeJS.ProcessEnv = process.env): CiFacts {
  const platform = detectPlatform(env);
  const label = LABELS[platform];
  switch (platform) {
    case 'github':
      return {
        platform, label,
        project: first(env, 'GITHUB_REPOSITORY'),
        branch: first(env, 'GITHUB_HEAD_REF') || shortBranch(first(env, 'GITHUB_REF')),
        sha: first(env, 'GITHUB_SHA'),
        changeRequest: /^refs\/pull\/(\d+)/.exec(first(env, 'GITHUB_REF'))?.[1] ?? '',
        runUrl: `${first(env, 'GITHUB_SERVER_URL') || 'https://github.com'}/${first(env, 'GITHUB_REPOSITORY')}/actions/runs/${first(env, 'GITHUB_RUN_ID')}`,
        runId: first(env, 'GITHUB_RUN_ID'),
      };
    case 'gitlab':
      return {
        platform, label,
        project: first(env, 'CI_PROJECT_PATH'),
        branch: first(env, 'CI_MERGE_REQUEST_SOURCE_BRANCH_NAME', 'CI_COMMIT_REF_NAME'),
        sha: first(env, 'CI_COMMIT_SHA'),
        changeRequest: first(env, 'CI_MERGE_REQUEST_IID'),
        runUrl: first(env, 'CI_JOB_URL', 'CI_PIPELINE_URL'),
        runId: first(env, 'CI_PIPELINE_ID', 'CI_JOB_ID'),
      };
    case 'jenkins':
      return {
        platform, label,
        // Jenkins names the job, not the repository, unless the git plugin filled GIT_URL.
        project: first(env, 'GIT_URL').replace(/^.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/, '$1') || first(env, 'JOB_NAME'),
        branch: shortBranch(first(env, 'CHANGE_BRANCH', 'BRANCH_NAME', 'GIT_BRANCH')).replace(/^origin\//, ''),
        sha: first(env, 'GIT_COMMIT'),
        changeRequest: first(env, 'CHANGE_ID'),
        runUrl: first(env, 'BUILD_URL'),
        runId: first(env, 'BUILD_NUMBER'),
      };
    case 'circleci':
      return {
        platform, label,
        project: [first(env, 'CIRCLE_PROJECT_USERNAME'), first(env, 'CIRCLE_PROJECT_REPONAME')].filter(Boolean).join('/'),
        branch: first(env, 'CIRCLE_BRANCH'),
        sha: first(env, 'CIRCLE_SHA1'),
        changeRequest: first(env, 'CIRCLE_PR_NUMBER'),
        runUrl: first(env, 'CIRCLE_BUILD_URL'),
        runId: first(env, 'CIRCLE_BUILD_NUM'),
      };
    case 'azure':
      return {
        platform, label,
        project: first(env, 'BUILD_REPOSITORY_NAME'),
        branch: shortBranch(first(env, 'SYSTEM_PULLREQUEST_SOURCEBRANCH', 'BUILD_SOURCEBRANCH')),
        sha: first(env, 'BUILD_SOURCEVERSION'),
        changeRequest: first(env, 'SYSTEM_PULLREQUEST_PULLREQUESTID'),
        runUrl: `${first(env, 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI')}${first(env, 'SYSTEM_TEAMPROJECT')}/_build/results?buildId=${first(env, 'BUILD_BUILDID')}`,
        runId: first(env, 'BUILD_BUILDID'),
      };
    case 'bitbucket':
      return {
        platform, label,
        project: first(env, 'BITBUCKET_REPO_FULL_NAME'),
        branch: first(env, 'BITBUCKET_BRANCH'),
        sha: first(env, 'BITBUCKET_COMMIT'),
        changeRequest: first(env, 'BITBUCKET_PR_ID'),
        runUrl: `https://bitbucket.org/${first(env, 'BITBUCKET_REPO_FULL_NAME')}/pipelines/results/${first(env, 'BITBUCKET_BUILD_NUMBER')}`,
        runId: first(env, 'BITBUCKET_BUILD_NUMBER'),
      };
    case 'travis':
      return {
        platform, label,
        project: first(env, 'TRAVIS_REPO_SLUG'),
        branch: first(env, 'TRAVIS_PULL_REQUEST_BRANCH', 'TRAVIS_BRANCH'),
        sha: first(env, 'TRAVIS_COMMIT'),
        changeRequest: first(env, 'TRAVIS_PULL_REQUEST') === 'false' ? '' : first(env, 'TRAVIS_PULL_REQUEST'),
        runUrl: first(env, 'TRAVIS_BUILD_WEB_URL'),
        runId: first(env, 'TRAVIS_BUILD_ID'),
      };
    case 'drone':
      return {
        platform, label,
        project: first(env, 'DRONE_REPO'),
        branch: first(env, 'DRONE_SOURCE_BRANCH', 'DRONE_BRANCH'),
        sha: first(env, 'DRONE_COMMIT_SHA'),
        changeRequest: first(env, 'DRONE_PULL_REQUEST'),
        runUrl: first(env, 'DRONE_BUILD_LINK'),
        runId: first(env, 'DRONE_BUILD_NUMBER'),
      };
    default:
      return { platform, label, project: '', branch: '', sha: '', changeRequest: '', runUrl: '', runId: `local-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}` };
  }
}

/** Where a platform wants a human-readable summary of the job, when it has such a place. */
export function summaryFile(env: NodeJS.ProcessEnv = process.env): string | null {
  return first(env, 'GITHUB_STEP_SUMMARY') || null;
}
