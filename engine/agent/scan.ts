// Reading an agent project once: its tools, its flows, its guards, its tests and its permissions.
//
// Split from agent-command.ts, which is the file in this project that keeps arriving at the
// 300-line limit. The rendering belongs with the thing it renders; the walk belongs here.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanSourceFiles } from '../walk.ts';
import { toolsIn, type AgentTool } from './tools.ts';
import { blank } from './source-text.ts';
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
 *
 * `evals?` was added after the evidence pack ran this check against Tewip's own repository and
 * reported five tools that can delete, pay or send - every one of them planted in `eval/` by the
 * recall harness that measures this very check. An eval harness declares fake tools as its whole
 * job, so reading them as shipped is the same mistake as reading a fixture as shipped, in the one
 * directory guaranteed to be full of the most alarming examples somebody could write.
 */
const NOT_SHIPPED = /(?:^|[\\/])(?:tests?|[\w-]+[_-]tests?|__tests__|spec|e2e|evals?|examples?|samples?|docs?|fixtures?|node_modules|\.venv|venv)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.py$|(?:^|[\\/])test_[^\\/]*\.py$/i;


/**
 * Minified or generated, by its shape rather than its name.
 *
 * Hand-written code averages well under a hundred characters a line whatever the language; a
 * bundler emits one line of hundreds of thousands. The size floor keeps a short file with one long
 * line - a single-line config, a long import list - out of it, because those are written by people.
 */
const isGenerated = (text: string): boolean => {
  if (text.length < 50_000) return false;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  return text.length / lines > 500;
};

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
    // A bundle somebody else built is not this project's agent.
    //
    // nocodb vendors `swagger-ui-bundle.min.js` under `public/js`, and the word `interrupt` appears
    // somewhere in the megabyte of it - so `tewip agent` reported that nocodb stops and asks a
    // person before acting. It does not; Swagger UI does something unrelated with that word. The
    // claim a reader takes from a guard finding is about *this* project's own code, and a vendored
    // bundle cannot support it either way. The test for it is shape rather than filename, because
    // the second of nocodb's two is not called `.min` and is minified all the same.
    if (isGenerated(text)) continue;
    filesRead += 1;
    // One blanking per file, shared by both readers.
    const blanked = blank(text, /\.py$/i.test(where));
    tools.push(...toolsIn(where, text, blanked));
    injections.push(...promptFlows(where, text));
    guards.push(...guardsIn(where, text, blanked));
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

