// `tewip incident <file>`: turn what happened in production into a test that proves it.
//
// The loop, and the reason each step is there:
//   read the incident      - deterministic, from Sentry, OpenTelemetry or a pasted stack trace
//   find the code it names - the project's own frames, so the test aims at real functions
//   write a failing test   - the model's only job, and the smallest one
//   run it                 - because a test nobody ran proves nothing
//   judge it               - red is not proof: it has to be red for the incident's reason
//
// Nothing is kept unless the judgement is "reproduced". A test that passes, fails its own way, or
// never ran is reported as exactly that and the file is removed, because a test wrongly labelled
// "reproduces the outage" is worse than no test: the next person will trust it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { noModelHelp } from '../llm/providers.ts';
import { writerFromEnv } from '../quality/model.ts';
import { usageLine } from '../llm/usage.ts';
import { chooseFramework, detectFrameworks } from '../quality/frameworks.ts';
import { draftTest } from '../quality/write.ts';
import { runTest } from '../quality/write-verify.ts';
import { ourFrames, readIncident, type Incident } from './incident.ts';
import { judgeReproduction, nextStep, type Judgement } from './reproduced.ts';

export interface IncidentCommand {
  root: string;
  /** The Sentry export, OpenTelemetry span or pasted stack trace. */
  file: string;
  framework?: string;
  /** Keep the test file even when it does reproduce; otherwise it is shown and removed. */
  keep?: boolean;
  out?: string;
}

/** The code the incident points at, so the test is written against real functions, not guesses. */
function codeFromFrames(root: string, incident: Incident): Array<{ file: string; content: string }> {
  const seen = new Set<string>();
  const out: Array<{ file: string; content: string }> = [];
  for (const frame of ourFrames(incident)) {
    // A production path (/app/src/pay.ts) rarely matches a checkout, so the tail is tried too.
    const candidates = [frame.file, ...frame.file.split('/').map((_, i, all) => all.slice(i).join('/'))];
    for (const candidate of candidates) {
      const path = resolve(root, candidate);
      if (seen.has(path) || !existsSync(path) || !path.startsWith(resolve(root))) continue;
      seen.add(path);
      out.push({ file: candidate, content: readFileSync(path, 'utf8').slice(0, 8000) });
      break;
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** The incident as a scenario the writer already knows how to take. */
function asScenario(incident: Incident) {
  const where = ourFrames(incident)[0];
  return {
    id: 'INCIDENT-1',
    title: `reproduce: ${incident.title}`.slice(0, 120),
    preconditions: [incident.operation ? `the system is doing: ${incident.operation}` : 'the code path below is exercised'],
    steps: [
      where ? `call the code in ${where.file}${where.fn ? ` (${where.fn})` : ''}${where.line ? ` around line ${where.line}` : ''} the way production did` : 'exercise the failing path',
      'do not guard against the failure; the test must hit it',
    ],
    expected: `it fails with ${[incident.errorType, incident.errorMessage].filter(Boolean).join(': ') || incident.title}. Write the test asserting the behaviour that SHOULD happen, so it is red now and green once the bug is fixed.`,
  } as never;
}

export interface IncidentResult {
  incident: Incident;
  judgement: Judgement | null;
  testFile: string;
  kept: boolean;
}

/**
 * How to import a source file from the folder the test will be written in.
 *
 * Always relative and always with a `./` or `../` in front, because a bare `access/render.ts` is a
 * package specifier to Node, not a path.
 */
export function importPathFor(root: string, testDir: string, file: string): string {
  const path = relative(resolve(testDir), resolve(root, file)).split('\\').join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

export async function runIncident(cmd: IncidentCommand): Promise<IncidentResult> {
  const incident = readIncident(readFileSync(resolve(cmd.file), 'utf8'));
  const framework = chooseFramework(detectFrameworks(cmd.root), cmd.framework, false);
  if (!framework) throw new Error('no test framework was found here, so there is nothing to write a test in. Run this inside the project.');

  const model = writerFromEnv(cmd.root);
  if (!model) throw new Error(`reproducing an incident needs a model to write the test.\n${noModelHelp()}`);

  const code = codeFromFrames(cmd.root, incident);
  console.error(`Read a ${incident.source} incident: ${incident.title.slice(0, 90)}`);
  console.error(code.length > 0 ? `It points at ${code.map((c) => c.file).join(', ')}.` : 'It names no file inside this project, so the test is written from the error alone.');

  // The framework names the file, so its runner picks it up and its imports resolve.
  const fileName = framework.fileFor(`incident-${Date.now().toString(36)}`);
  const testFile = join(framework.testDir, fileName);
  mkdirSync(dirname(testFile), { recursive: true });

  // Each source file with the path to import it by from the test's own folder. Without this the
  // model only had project-relative paths and every import it wrote was wrong for any framework
  // whose test folder is not the project root.
  const withImports = code.map((c) => ({ ...c, importPath: importPathFor(cmd.root, framework.testDir, c.file) }));
  const draft = await draftTest(
    model,
    { framework, fileName, pages: [], feature: `A production incident: ${incident.title}`, code: withImports, testDir: relative(cmd.root, framework.testDir).split('\\').join('/') || '.' },
    asScenario(incident),
  );
  writeFileSync(testFile, draft.code, 'utf8');
  console.error('Wrote the test; running it now, because a test nobody ran proves nothing…');

  const run = runTest(framework, testFile);
  const judgement = judgeReproduction(incident, { passed: run.passed, output: run.output });
  const kept = judgement.verdict === 'reproduced';
  if (!kept) rmSync(testFile, { force: true });

  const report = renderIncident(incident, judgement, kept ? testFile : '', draft.code);
  console.log(report);
  console.error(`\n${usageLine()}`);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), `${report}\n`, 'utf8');
  }
  return { incident, judgement, testFile: kept ? testFile : '', kept };
}

export function renderIncident(incident: Incident, judgement: Judgement, testFile: string, code: string): string {
  const where = ourFrames(incident)[0];
  const lines = [
    `# ${judgement.verdict === 'reproduced' ? 'Reproduced' : 'Not reproduced'}: ${incident.title.slice(0, 100)}`,
    '',
    `Read from ${incident.source}.${incident.operation ? ` During: ${incident.operation}.` : ''}`,
    `Production reported: ${[incident.errorType, incident.errorMessage].filter(Boolean).join(': ') || '(no error text)'}`,
    where ? `Your code in the trace: ${where.file}${where.line ? `:${where.line}` : ''}${where.fn ? ` (${where.fn})` : ''}` : 'No file of yours appears in the trace.',
    '',
    `## ${judgement.verdict === 'reproduced' ? 'The test is red for the right reason' : 'Nothing is kept'}`,
    '',
    judgement.why,
    '',
    `**Do:** ${nextStep[judgement.verdict]}`,
    '',
  ];
  if (testFile) lines.push(`The test is at \`${testFile}\`. It should stay red until the bug is fixed, and turning it green is the proof that it was.`, '');
  else lines.push('The test Tewip wrote is below, unkept, so you can see what was tried:', '', '```', code.slice(0, 2000), '```', '');
  lines.push('Tewip never keeps a test that has not been run, and never calls a red test a reproduction unless it is red for the reason production was.');
  return lines.join('\n');
}
