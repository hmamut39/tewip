// Reading an agent project once: its tools, its flows, its guards, its tests and its permissions.
//
// Split from agent-command.ts, which is the file in this project that keeps arriving at the
// 300-line limit. The rendering belongs with the thing it renders; the walk belongs here.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanSourceFiles } from '../walk.ts';
import { toolsIn, type AgentTool } from './tools.ts';
import { promptFlows, type PromptFlow } from './prompt-flow.ts';
import { budgetSetToNothing, guardsIn, type Guard } from './guards.ts';
import { scanConfig, type ConfigScan } from './claude-config.ts';
import { coverageOf, evalEvidence, type EvalEvidence, type ToolCoverage } from './tool-tests.ts';

const NL = String.fromCharCode(10);
const AGENT_FILE = /\.(?:py|[cm]?[jt]sx?)$/i;
/**
 * What is not the shipped agent.
 *
 * The first version of this named the directory `tests` and the file `*.test.ts`, which is what the
 * documentation of every project says and not what projects do. Run against the OpenAI Agents SDK,
 * all 24 "tools" it reported were fixtures in `integration_tests/` and `test_*.py` - a directory
 * whose name ends in `tests` rather than being `tests`, and a Python convention that puts the word
 * at the front of the file. A list of an agent's tools that is actually a list of test doubles is
 * worse than no list.
 *
 * `[\w-]+[_-]tests?` and not `[\w-]*tests?`, because the second one also excludes `latest/`.
 */
const NOT_SHIPPED = /(?:^|[\\/])(?:tests?|[\w-]+[_-]tests?|__tests__|spec|e2e|examples?|samples?|docs?|fixtures?|node_modules|\.venv|venv)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.py$|(?:^|[\\/])test_[^\\/]*\.py$/i;


export interface AgentScan {
  tools: AgentTool[];
  /** Untrusted text glued into a prompt, in the same function. */
  injections: PromptFlow[];
  guards: Guard[];
  filesRead: number;
  /** Which tools anybody ever mentioned in a test. */
  coverage: ToolCoverage[];
  evals: EvalEvidence;
  /** What the installed coding agent was permitted to do here. */
  config: ConfigScan;
  /** A ceiling that exists in name only. */
  emptyBudget: { file: string; text: string } | null;
}

export function scanAgent(root: string): AgentScan {
  const scan = scanSourceFiles(root, 20_000, (f) => AGENT_FILE.test(f));
  const tools: AgentTool[] = [];
  const tests: Array<{ file: string; text: string }> = [];
  const injections: PromptFlow[] = [];
  const guards: Guard[] = [];
  let emptyBudget: AgentScan['emptyBudget'] = null;
  let filesRead = 0;
  for (const path of scan.files) {
    const where = relative(root, path).replace(/\\/g, '/');
    // Excluded from the tool scan, but not thrown away: these files are the evidence for whether
    // anybody ever wrote a test about a tool, which is a different question from what ships.
    if (NOT_SHIPPED.test(where)) {
      try {
        tests.push({ file: where, text: readFileSync(path, 'utf8') });
      } catch {
        // A file that cannot be read is not evidence of a test, and is not counted as one.
      }
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    filesRead += 1;
    tools.push(...toolsIn(where, text));
    injections.push(...promptFlows(where, text));
    guards.push(...guardsIn(where, text));
    if (!emptyBudget) {
      const empty = budgetSetToNothing(text);
      if (empty) emptyBudget = { file: where, text: empty };
    }
  }
  const manifests = ['package.json', 'pyproject.toml', 'requirements.txt'].flatMap((m) => {
    try {
      return [readFileSync(join(root, m), 'utf8')];
    } catch {
      return [];
    }
  });
  return {
    tools,
    injections,
    guards,
    filesRead,
    emptyBudget,
    coverage: coverageOf(tools.map((t) => t.name), tests),
    evals: evalEvidence(tests, manifests),
    config: scanConfig(root),
  };
}

