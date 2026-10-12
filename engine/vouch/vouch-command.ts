// `tewip vouch <paths>`: which of these tests could never fail.
//
// Costs nothing and calls no model: every verdict is a line of the file quoted back. The report is
// ordered for a reviewer with ten minutes - what cannot fail, then what does not run, then what
// Tewip would not judge - and it ends with what it refused, because that is what makes the rest of
// it believable.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { normalise } from '../quality/source-text.ts';
import { join, relative } from 'node:path';
import { CANNOT_FAIL, vouchFile, type FileVouch, type Judgement, type Verdict } from './vouch.ts';

export interface VouchCommand {
  root: string;
  paths: string[];
  json?: string;
  out?: string;
  /** Exit non-zero when a test that cannot fail is found, for use as a gate. */
  strict?: boolean;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', 'target', '.venv', '__pycache__', '.tewip']);

/** Every file under these paths that could hold tests. */
export function testFiles(root: string, paths: string[]): string[] {
  const found: string[] = [];
  const walk = (where: string, depth: number): void => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(where);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(where, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      // rb, php and rs added in Phase 36. They were missing here as well as in languageOf, so even
      // a file named outright came back "0 test(s) read in 0 file(s)" - which reads like a clean
      // answer and is not one.
      else if (/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|java|kt|kts|scala|groovy|go|cs|fs|rb|php|rs)$/i.test(entry)) found.push(full);
    }
  };
  for (const path of paths) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, 0);
    else found.push(full);
  }
  return found;
}

export function vouchAll(root: string, paths: string[]): FileVouch[] {
  const out: FileVouch[] = [];
  for (const file of testFiles(root, paths)) {
    let text: string;
    try {
      text = normalise(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (text.length > 2_000_000) continue; // a generated file, not a test somebody wrote
    const vouched = vouchFile(relative(root, file).split('\\').join('/'), text);
    if (vouched.judgements.length > 0 || vouched.focused) out.push(vouched);
  }
  return out;
}

const count = (all: Judgement[], verdict: Verdict): number => all.filter((j) => j.verdict === verdict).length;

export function renderVouch(files: FileVouch[]): string {
  const all = files.flatMap((f) => f.judgements);
  const cannotFail = all.filter((j) => CANNOT_FAIL.includes(j.verdict));
  const crashOnly = count(all, 'crash-only');
  const lines = [
    '# Which of these tests could fail?',
    '',
    `${all.length} test(s) read in ${files.length} file(s). **${cannotFail.length} cannot fail at all.** ${crashOnly} compare no value, so only a crash would fail them. ${count(all, 'cannot-tell')} Tewip would not judge.`,
    '',
    'A test that cannot fail still passes, still counts towards coverage, and still looks like work.',
    '',
  ];

  if (cannotFail.length === 0) {
    lines.push('## Nothing here is unable to fail', '', 'Every test read can be broken by a change to the code, or by the code throwing.', '');
  }

  for (const verdict of CANNOT_FAIL) {
    const group = cannotFail.filter((j) => j.verdict === verdict);
    if (group.length === 0) continue;
    lines.push(`## ${TITLES[verdict]} (${group.length})`, '');
    for (const j of group) {
      lines.push(`- **${j.name}** — ${j.file}:${j.line}`);
      if (j.evidence) lines.push(`  - \`${j.evidence.replace(/`/g, "'")}\``);
      lines.push(`  - ${j.why}`);
    }
    lines.push('');
  }

  const focused = files.filter((f) => f.focused);
  if (focused.length > 0) {
    lines.push(`## Files where most tests do not run (${focused.length})`, '');
    for (const f of focused) lines.push(`- ${f.file}: ${f.focused}`);
    lines.push('');
  }

  const weak = all.filter((j) => j.verdict === 'crash-only');
  if (weak.length > 0) {
    lines.push(
      `## Compare no value (${weak.length})`,
      '',
      'These are not broken. They fail if the code throws and pass whatever it returns, which is',
      'sometimes exactly the intention - a test that compiles a fixture and runs it is checking that',
      'nothing blew up. Worth a look where a value was meant to be checked.',
      '',
    );
    for (const j of weak.slice(0, 40)) lines.push(`- ${j.name} — ${j.file}:${j.line}: \`${j.evidence.replace(/`/g, "'")}\``);
    if (weak.length > 40) lines.push(`- …and ${weak.length - 40} more`);
    lines.push('');
  }

  const undecided = all.filter((j) => j.verdict === 'cannot-tell');
  if (undecided.length > 0) {
    lines.push(`## Not judged (${undecided.length})`, '', 'Tewip will not call these either way, because the checking may be somewhere it cannot follow.', '');
    for (const j of undecided.slice(0, 25)) lines.push(`- ${j.name} — ${j.file}:${j.line}: ${j.evidence}`);
    if (undecided.length > 25) lines.push(`- …and ${undecided.length - 25} more`);
    lines.push('');
  }

  lines.push(
    '---',
    '',
    'Every verdict above quotes the line it is based on, and nothing was inferred by a model: this',
    'costs nothing to run. Where the checking happens in a helper Tewip cannot follow it says so',
    'rather than guessing, which is why the list above is worth reading.',
    '',
    'What this does not tell you is how many it missed. Everything it reports here has been measured',
    'for correctness on real projects; its recall has not been measured at all, so a clean report is',
    'not proof that every test in these files is worth something.',
  );
  return lines.join(String.fromCharCode(10));
}

const TITLES: Record<Verdict, string> = {
  'crash-only': 'Compares no value: only a crash can fail it',
  'unfinished-expectation': 'An expectation nobody finished',
  tautology: 'Compares a value with itself',
  'swallows-failure': 'Discards its own failure',
  'never-runs': 'Never runs',
  'cannot-tell': 'Not judged',
  checks: 'Can fail',
};
