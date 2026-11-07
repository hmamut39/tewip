// Which of this agent's tools anybody ever tested, and whether an eval set exists at all.
//
// "Green tests don't prove that agent code works" is the line every serious write-up of agent
// engineering lands on, and the failure list under it is always the same: no eval set, unchecked
// outputs, vibe-based testing. Those are usually presented as things to feel bad about. Two of
// them are decidable by reading.
//
// The useful question is not "does this project have tests" - every project has tests - but **is
// this particular tool mentioned in any of them**. An agent with six tools that cannot be undone
// and four of them appearing in no test is a specific, checkable sentence, and it is the one a
// reviewer can act on. It needs no runtime, no model and no eval harness, and it works on a
// project that has never heard of one.
//
// What it is not: a claim that a tool is *well* tested. A name appearing in a test file means
// somebody wrote it down there, nothing more - a mock, a fixture or a real exercise all look the
// same from here. The report says that in those words, because "tested" is exactly the word a
// reader will otherwise supply for themselves.
export interface ToolCoverage {
  name: string;
  /** Test files that mention this tool by name. */
  mentionedIn: string[];
  /** True when the name is too short or too common to decide on. */
  tooCommon: boolean;
}

export interface EvalEvidence {
  /** Eval frameworks this project depends on or imports. */
  frameworks: string[];
  /** Files and folders that look like an eval set rather than a unit test. */
  files: string[];
}

/**
 * Eval frameworks, by the name they are imported or depended on under.
 *
 * Named rather than guessed at. The point of listing them is to be able to say "this project has
 * one, here it is" or "none of these is here" - and the second sentence is only honest if the list
 * is written down where a reader can see what was looked for.
 */
const FRAMEWORKS: Array<{ name: string; re: RegExp }> = [
  { name: 'DeepEval', re: /\bdeepeval\b/i },
  { name: 'promptfoo', re: /\bpromptfoo\b/i },
  { name: 'Ragas', re: /\bragas\b/i },
  { name: 'LangSmith', re: /\blangsmith\b/i },
  { name: 'Braintrust', re: /\bbraintrust\b/i },
  { name: 'Inspect AI', re: /\binspect_ai\b/i },
  { name: 'Giskard', re: /\bgiskard\b/i },
  { name: 'TruLens', re: /\btrulens\b/i },
  { name: 'Langfuse', re: /\blangfuse\b/i },
  { name: 'OpenAI Evals', re: /\bopenai[-_]?evals\b/i },
];

/** A path that holds an eval set rather than a unit test. */
const EVAL_PATH = /(?:^|[\\/])(?:evals?|benchmarks?|golden|datasets?)[\\/]|\.eval\.[cm]?[jt]s$|_eval\.py$|eval_[^\\/]*\.(?:py|[cm]?[jt]s)$|\bevals?\.ya?ml$/i;

/**
 * Names too common to decide on.
 *
 * A tool called `get` or `run` appears in every file in the project, so finding it in a test file
 * says nothing at all. Rather than counting those as covered - which is the comfortable direction
 * and the wrong one - they are reported as undecidable, by name.
 */
const COMMON = new Set(['get', 'set', 'run', 'add', 'list', 'read', 'write', 'call', 'send', 'find', 'query', 'search', 'name', 'tool', 'test', 'echo', 'exec', 'open', 'close', 'load', 'save']);

const tooCommonName = (name: string): boolean => name.length < 5 || COMMON.has(name.toLowerCase());

export function coverageOf(toolNames: string[], tests: Array<{ file: string; text: string }>): ToolCoverage[] {
  return toolNames.map((name) => {
    if (tooCommonName(name)) return { name, mentionedIn: [], tooCommon: true };
    // Word boundaries on both sides: `delete_user` must not be matched by `delete_user_profile`,
    // which is a different tool and may well be the only one anybody tested.
    const mention = new RegExp(String.raw`(?<![\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`);
    return { name, mentionedIn: tests.filter((t) => mention.test(t.text)).map((t) => t.file), tooCommon: false };
  });
}

export function evalEvidence(files: Array<{ file: string; text: string }>, manifests: string[]): EvalEvidence {
  const frameworks = new Set<string>();
  for (const { name, re } of FRAMEWORKS) {
    if (manifests.some((m) => re.test(m)) || files.some((f) => re.test(f.text))) frameworks.add(name);
  }
  const evalFiles = files.filter((f) => EVAL_PATH.test(f.file)).map((f) => f.file);
  return { frameworks: [...frameworks], files: [...new Set(evalFiles)].slice(0, 12) };
}

/** The names of every eval framework looked for, so silence about them can be read correctly. */
export const FRAMEWORKS_LOOKED_FOR = FRAMEWORKS.map((f) => f.name);

/**
 * Which tools anybody wrote a test about, rendered where the logic for deciding it lives.
 *
 * Split out for the same reason the config section was: agent-command.ts is the file that keeps
 * reaching the 300-line limit, and a report section belongs beside the thing it reports on.
 */
export function coverageSection(coverage: ToolCoverage[], tools: Array<{ name: string; reach: string }>, evals: EvalEvidence): string[] {
  const lines: string[] = [];
  const IRREV = ['destructive', 'deletes', 'pays', 'sends', 'runs-code'];
  const untested = coverage.filter((c) => !c.tooCommon && c.mentionedIn.length === 0);
  const riskyUntested = untested.filter((u) => IRREV.includes(tools.find((t) => t.name === u.name)?.reach ?? 'reads'));
  lines.push('## Which of these anybody wrote a test about', '');
  lines.push(
    untested.length === 0
      ? 'Every tool whose name is distinctive enough to look for appears in at least one test file.'
      : `**${untested.length} of ${tools.length}** appear in no test file${riskyUntested.length > 0 ? `, and ${riskyUntested.length} of those cannot be undone` : ''}.`,
    '',
  );
  if (untested.length > 0) {
    for (const u of untested.slice(0, 15)) {
      const reach = tools.find((t) => t.name === u.name)?.reach;
      lines.push(`- \`${u.name}\`${reach && IRREV.includes(reach) ? ' — **and it cannot be undone**' : ''}`);
    }
    if (untested.length > 15) lines.push(`…and ${untested.length - 15} more`);
    lines.push('');
  }
  const undecidable = coverage.filter((c) => c.tooCommon);
  if (undecidable.length > 0) {
    lines.push(
      `Not decided for ${undecidable.length}: ${undecidable.slice(0, 8).map((u) => `\`${u.name}\``).join(', ')}. A name this`,
      'short or this common appears everywhere, so finding it in a test file would prove nothing.',
      '',
    );
  }
  lines.push(
    evals.frameworks.length > 0
      ? `Eval framework in this project: ${evals.frameworks.join(', ')}.`
      : `No eval framework found. Looked for: ${FRAMEWORKS_LOOKED_FOR.join(', ')}.`,
    '',
  );
  if (evals.files.length > 0) lines.push(`Eval sets: ${evals.files.map((f) => `\`${f}\``).join(', ')}.`, '');
  lines.push(
    'A name appearing in a test file means somebody wrote it down there. Whether that test exercises',
    'the tool, mocks it, or only imports it is not decided here.',
    '',
    'And the other way round, which matters more: a tool missing from this list is not a tool whose',
    'behaviour is untested. It is a tool nothing tests **by that name** - the wiring between the name',
    'the model sees and the code behind it. Tewip finds 8 of its own 17 this way, and the engine under',
    'each one is covered; what nothing exercises is the tool surface itself.',
    '',
  );

  return lines;
}
