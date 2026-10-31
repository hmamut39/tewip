// Proving what a pull request's own changes would slip past, inside CI.
//
// `tewip prove` on a whole file is a thing somebody chooses to wait for. In CI nobody chooses, so this
// is deliberately meaner: only source files the diff touched, a small number of them, a hard time
// budget, and off unless the repository asks for it. A tool that silently adds six minutes to every
// pull request is a tool that gets removed from the workflow, and then it checks nothing at all.
//
// It says nothing when nothing slipped past. A section that appears on every pull request to report
// "all good" is one people stop reading, and then it is worth nothing on the day it matters.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chooseFramework, detectFrameworks } from '../quality/frameworks.ts';
import { coverageFor, testFiles } from '../review/coverage.ts';
import { importingTests, proveFile, type Proof } from './prove.ts';
import { testsReaching } from './reaches.ts';

const SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|java|kt|go|cs|rb|php)$/i;
const IS_TEST = /(^|[\\/])(tests?|spec|specs|__tests__|e2e)[\\/]|[._-](test|tests|spec|specs)\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs)$/i;

export interface ProvedChange {
  proofs: Proof[];
  unnoticed: number;
  /** Files the budget never reached, so the report does not imply they were clean. */
  notReached: string[];
  /** Why nothing ran at all, when nothing did. */
  skipped: string;
}

export interface ProveBudget {
  /** Source files from the diff to prove, most recently changed first. */
  maxFiles?: number;
  /** Changes to try per file. */
  limit?: number;
  /** Seconds for the whole thing, across every file. */
  budgetSeconds?: number;
  /**
   * The lines this change actually touched, per file, from `changedLinesByFile`. Given them, only
   * those lines are mutated - which is the question this file claims to answer in its own first
   * sentence and, until it was measured, did not.
   */
  lines?: ReadonlyMap<string, ReadonlySet<number>>;
  onStep?: (message: string) => void;
}

/**
 * The line numbers a range added or changed, per file, asked of git rather than reconstructed.
 *
 * `-U0` is the whole trick: with no context lines, every hunk header names exactly the lines that
 * changed. With the default three lines of context the numbers quietly include six lines nobody
 * touched, which on a small change is most of them.
 *
 * A range git cannot resolve returns an empty map, and an empty map means "mutate the file as
 * before" rather than "mutate nothing" - not knowing which lines changed is a reason to fall back,
 * where knowing they hold nothing mutable is a reason to say so.
 */
export function changedLinesByFile(root: string, range: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let diff: string;
  try {
    diff = execFileSync('git', ['diff', '-U0', range], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return out;
  }
  let file = '';
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1].split('\\').join('/');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    // A hunk with a count of 0 is a pure deletion: there is no new line to mutate.
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const start = Number(hunk[1]);
    const set = out.get(file) ?? new Set<number>();
    for (let i = 0; i < count; i++) set.add(start + i);
    if (set.size > 0) out.set(file, set);
  }
  return out;
}

export function proveChanged(root: string, changed: string[], budget: ProveBudget = {}): ProvedChange {
  const maxFiles = budget.maxFiles ?? 2;
  const totalMs = (budget.budgetSeconds ?? 300) * 1000;
  const say = budget.onStep ?? (() => {});
  const files = changed.map((f) => f.split('\\').join('/')).filter((f) => SOURCE.test(f) && !IS_TEST.test(f) && existsSync(resolve(root, f)));
  if (files.length === 0) return { proofs: [], unnoticed: 0, notReached: [], skipped: 'this change touches no source file that could be proved' };

  const framework = chooseFramework(detectFrameworks(root), undefined, false);
  if (!framework) return { proofs: [], unnoticed: 0, notReached: [], skipped: 'no unit test framework was found here, and proving works by running tests' };

  const known = testFiles(root);
  const started = Date.now();
  const proofs: Proof[] = [];
  const chosen = files.slice(0, maxFiles);
  const notReached = files.slice(maxFiles);

  for (const file of chosen) {
    const left = totalMs - (Date.now() - started);
    // Under half a minute is not enough for a baseline, a control and one change, and a run cut off
    // half way would report survivors that were never really tried.
    if (left < 30_000) {
      notReached.push(file);
      continue;
    }
    const direct = importingTests(root, coverageFor(root, [file], known), file);
    const covering = direct.length > 0 ? direct : testsReaching(root, file, known.map((t) => t.split('\\').join('/'))).map((r) => r.testFile);
    const onlyLines = budget.lines?.get(file);
    say(`proving ${file} against ${covering.length} test file(s)${onlyLines ? `, on the ${onlyLines.size} line(s) it changed` : ''}`);
    proofs.push(proveFile(root, file, covering, framework, { limit: budget.limit ?? 4, budgetSeconds: Math.floor(left / 1000), onStep: say, ...(onlyLines ? { onlyLines } : {}) }));
  }

  return {
    proofs,
    unnoticed: proofs.flatMap((p) => p.tried).filter((t) => t.fate === 'unnoticed').length,
    notReached,
    skipped: '',
  };
}

/** The section for the pull request comment. Empty when nothing slipped past. */
export function provedChangeLines(proved: ProvedChange): string[] {
  const gaps = proved.proofs.flatMap((p) => p.tried.filter((t) => t.fate === 'unnoticed').map((t) => ({ file: p.file, tried: t })));
  if (gaps.length === 0) return [];
  const lines = [
    `## ${gaps.length} change(s) to this code would have slipped past the tests`,
    '',
    'Tewip made each of these changes to your own code and ran the tests that cover it. They all still',
    'passed. The lines are covered; they are not checked.',
    '',
  ];
  for (const gap of gaps.slice(0, 8)) {
    lines.push(`- **\`${gap.file}:${gap.tried.mutant.line}\`** — ${gap.tried.mutant.kind}`);
    lines.push(`  - was: \`${gap.tried.mutant.was.slice(0, 110).replace(/`/g, "'")}\``);
    lines.push(`  - became: \`${gap.tried.mutant.now.slice(0, 110).replace(/`/g, "'")}\``);
  }
  if (gaps.length > 8) lines.push(`- …and ${gaps.length - 8} more`);
  lines.push('', 'Every file was put back exactly as it was. Nothing here is necessarily a bug: it is a place where a mistake would go unnoticed.', '');
  if (proved.notReached.length > 0) {
    lines.push(`Not proved in the time allowed: ${proved.notReached.slice(0, 6).join(', ')}${proved.notReached.length > 6 ? `, and ${proved.notReached.length - 6} more` : ''}.`, '');
  }
  return lines;
}
