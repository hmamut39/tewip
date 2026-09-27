// `tewip prove <file>`: what your tests would not catch, shown by breaking the code and watching.
//
// The report is written for the reader who has to decide whether to trust a suite. It leads with what
// went unnoticed, quotes the exact change, names the test that caught each one that was caught, and
// says what the answer cost in seconds - because this is the one command here that is slow, and a
// number somebody waited four minutes for should say how long it took.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { changeSummary } from '../quality/grounding.ts';
import { chooseFramework, detectFrameworks } from '../quality/frameworks.ts';
import { coverageFor, testFiles } from '../review/coverage.ts';
import { importingTests, proveFile, type Proof } from './prove.ts';
import { testsReaching } from './reaches.ts';

export interface ProveCommand {
  root: string;
  /** Files to prove. Empty with a diff range means the source files that range changed. */
  files: string[];
  diff?: string;
  limit?: number;
  budgetSeconds?: number;
  out?: string;
  /** Exit non-zero when a change went unnoticed, for use as a gate. */
  strict?: boolean;
}

const SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|java|kt|go|cs|rb|php)$/i;
const IS_TEST = /(^|[\\/])(tests?|spec|specs|__tests__|e2e)[\\/]|[._-](test|tests|spec|specs)\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs)$/i;

/** The source files to prove: the ones named, or the ones a change touched. */
export function filesToProve(cmd: ProveCommand): string[] {
  if (cmd.files.length > 0) return cmd.files.map((f) => f.split('\\').join('/'));
  if (!cmd.diff) return [];
  const change = changeSummary(cmd.root, cmd.diff);
  if (!change) return [];
  return change.files.map((f) => f.split('\\').join('/')).filter((f) => SOURCE.test(f) && !IS_TEST.test(f) && existsSync(resolve(cmd.root, f)));
}

export function renderProof(proofs: Proof[]): string {
  const tried = proofs.flatMap((p) => p.tried);
  const unnoticed = tried.filter((t) => t.fate === 'unnoticed');
  const noticed = tried.filter((t) => t.fate === 'noticed');
  const invalid = tried.filter((t) => t.fate === 'did-not-compile');
  const broke = tried.filter((t) => t.fate === 'runner-broke');
  const seconds = proofs.reduce((total, p) => total + p.seconds, 0);

  const lines = [
    '# What your tests would not catch',
    '',
    tried.length === 0
      ? 'Nothing was tried. See below for why.'
      : `${tried.length} change(s) were made to your code and the covering tests were run against each. **${unnoticed.length} went unnoticed.** ${noticed.length} were caught. Took ${seconds}s.`,
    '',
  ];

  if (unnoticed.length > 0) {
    lines.push(
      `## Unnoticed (${unnoticed.length})`,
      '',
      'Each of these is a change to your code that every test covering it still passed. The line was',
      'covered; it was not checked.',
      '',
    );
    for (const proof of proofs) {
      const gaps = proof.tried.filter((t) => t.fate === 'unnoticed');
      if (gaps.length === 0) continue;
      lines.push(`### ${proof.file}`, '');
      for (const gap of gaps) {
        lines.push(`- **line ${gap.mutant.line}: ${gap.mutant.kind}**`);
        lines.push(`  - was: \`${gap.mutant.was.slice(0, 120)}\``);
        lines.push(`  - became: \`${gap.mutant.now.slice(0, 120)}\``);
      }
      lines.push('', `Run by: ${proof.covering.join(', ')}`, '');
    }
  }

  if (noticed.length > 0) {
    lines.push(`## Caught (${noticed.length})`, '', 'These your tests would have stopped.', '');
    for (const good of noticed) lines.push(`- line ${good.mutant.line}: ${good.mutant.kind} — caught by \`${good.noticedBy}\``);
    lines.push('');
  }

  const blocked = proofs.filter((p) => p.blocked);
  if (blocked.length > 0) {
    lines.push(`## Nothing could be proved here (${blocked.length})`, '');
    for (const p of blocked) lines.push(`- **${p.file}**: ${p.blocked}`);
    lines.push('');
  }

  if (invalid.length > 0 || broke.length > 0 || proofs.some((p) => p.notTried > 0 || p.setAside.length > 0)) {
    lines.push('## Not counted', '');
    if (invalid.length > 0) lines.push(`- ${invalid.length} change(s) did not compile, so they say nothing about the tests. That is Tewip's fault, not yours.`);
    for (const p of proofs) for (const aside of p.setAside) lines.push(`- \`${aside.test}\` was set aside: ${aside.why}. It covers ${p.file}, so it may well notice things the tests above did not.`);
    if (broke.length > 0) lines.push(`- ${broke.length} run(s) broke in the environment rather than the tests.`);
    const left = proofs.reduce((total, p) => total + p.notTried, 0);
    if (left > 0) lines.push(`- ${left} change(s) were never tried: the time budget ran out. Raise it with \`--budget <seconds>\`.`);
    lines.push('');
  }

  lines.push(
    '---',
    '',
    'Every line above was proved by running your own tests against your own code, one small change at',
    'a time, and every file was put back exactly as it was. No model was called.',
    '',
    'What this does not say: that the unnoticed changes are bugs, or that the caught ones mean the',
    'suite is good. It says only which of these particular mistakes your tests would have stopped -',
    'which is more than a coverage percentage can tell you, and less than a proof that the code works.',
  );
  return lines.join(String.fromCharCode(10));
}

/**
 * One file, proved, with nothing printed: what the MCP server and any other caller use. `runProve`
 * prints as it goes because a person waiting minutes deserves to see progress; over a protocol that
 * speaks on stdout, printing would corrupt the stream.
 */
export function proveOne(root: string, file: string, opts: { limit?: number; budgetSeconds?: number } = {}): string {
  const framework = chooseFramework(detectFrameworks(root), undefined, false);
  if (!framework) return 'No unit test framework was found here (jest, vitest, mocha, node --test, pytest, go test, maven, gradle, dotnet). Proving works by running your tests, so it needs one.';
  if (!existsSync(resolve(root, file))) return `No such file here: ${file}`;
  const covering = coveringTests(root, file, testFiles(root));
  return renderProof([proveFile(root, file, covering.tests, framework, { limit: opts.limit, budgetSeconds: opts.budgetSeconds })]);
}

/** The tests that could notice a change here: the ones that import the file, else the ones that reach it. */
function coveringTests(root: string, file: string, known: string[]): { tests: string[]; how: string } {
  const direct = importingTests(root, coverageFor(root, [file], known), file);
  if (direct.length > 0) return { tests: direct, how: 'import it directly' };
  const reached = testsReaching(root, file, known.map((t) => t.split(String.fromCharCode(92)).join('/')));
  return { tests: reached.map((r) => r.testFile), how: reached.length > 0 ? `reach it through ${reached[0].steps} import(s), via ${reached[0].via}` : 'import it' };
}

export function runProve(cmd: ProveCommand): { proofs: Proof[]; unnoticed: number } {
  const files = filesToProve(cmd);
  if (files.length === 0) {
    throw new Error('name a source file to prove, or pass --diff main...HEAD to prove what a change touched');
  }

  // A unit framework, never a browser one: proving needs dozens of runs, and a browser run costs
  // minutes. Browser tests are where `tewip fix` and the drift lab work instead.
  const framework = chooseFramework(detectFrameworks(cmd.root), undefined, false);
  if (!framework) {
    throw new Error('no unit test framework was found here (jest, vitest, mocha, pytest, go test, maven, gradle, dotnet). Proving needs one, because it works by running your tests.');
  }

  const known = testFiles(cmd.root);
  const proofs: Proof[] = [];
  for (const file of files) {
    if (!existsSync(resolve(cmd.root, file))) {
      proofs.push({ file, covering: [], tried: [], blocked: 'no such file here', setAside: [], notTried: 0, seconds: 0 });
      continue;
    }
    // Nothing importing it by name is the normal case in a layered codebase, not the absence of
    // tests, so the import chain is followed outwards before anything is concluded.
    const { tests: covering, how } = coveringTests(cmd.root, file, known);
    console.error(`${file}: ${covering.length} test file(s) ${how}`);
    proofs.push(
      proveFile(cmd.root, file, covering, framework, {
        limit: cmd.limit,
        budgetSeconds: cmd.budgetSeconds,
        onStep: (message) => console.error(`  ${message}`),
      }),
    );
  }

  const report = renderProof(proofs);
  console.log(report);
  if (cmd.out) {
    mkdirSync(dirname(resolve(cmd.out)), { recursive: true });
    writeFileSync(resolve(cmd.out), report + String.fromCharCode(10), 'utf8');
  }

  const unnoticed = proofs.flatMap((p) => p.tried).filter((t) => t.fate === 'unnoticed').length;
  if (cmd.strict && unnoticed > 0) {
    console.error(String.fromCharCode(10) + `${unnoticed} change(s) to your code went unnoticed by the tests covering it.`);
    process.exitCode = 1;
  }
  return { proofs, unnoticed };
}

/** Kept so a caller that only wants the numbers does not have to parse the report. */
export const readSource = (root: string, file: string): string => readFileSync(resolve(root, file), 'utf8');

export const shortName = (root: string, file: string): string => relative(root, resolve(root, file)).split('\\').join('/');
