// `tewip vouch <paths>`: which of these tests could never fail.
//
// Costs nothing and calls no model: every verdict is a line of the file quoted back. The report is
// ordered for a reviewer with ten minutes - what cannot fail, then what does not run, then what
// Tewip would not judge - and it ends with what it refused, because that is what makes the rest of
// it believable.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { normalise } from '../quality/source-text.ts';
import { isAbsolute, join, relative } from 'node:path';
import { CANNOT_FAIL, vouchFile, type FileVouch, type Judgement, type Verdict } from './vouch.ts';
import { unreadableOf } from './tests-in.ts';

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
export function testFiles(root: string, paths: string[], skipped?: Map<string, number>): string[] {
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
      // Phase 186. Everything else fell out of this walk without a trace. On a clone of the Flutter
      // SDK that meant 2,743 Dart test files, and `vouch` reported "1088 test(s) read in 112
      // file(s)" over the Android corner written in Java - a verdict a Flutter team would
      // reasonably have read as covering their suite.
      else if (skipped) {
        const cannot = unreadableOf(entry);
        if (cannot) skipped.set(cannot, (skipped.get(cannot) ?? 0) + 1);
      }
    }
  };
  for (const path of paths) {
    // An absolute path is used as it stands. `join(root, 'C:/x/y.test.js')` produces a path under
    // the project that does not exist, so `tewip vouch <absolute>` read nothing and reported "no
    // test file was read" - which is the honest sentence for the wrong reason. Found in Phase 193
    // by writing the Claude Code hook, because a hook is only ever handed an absolute path.
    const full = isAbsolute(path) ? path : join(root, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, 0);
    else found.push(full);
  }
  return found;
}

/**
 * Source files `testFiles` walked past because Tewip cannot read the language, by language.
 *
 * Same walk, so the counts describe the same ground the verdict does. It counts source files rather
 * than guessing which are tests: naming conventions differ per language and a count that overstates
 * what it skipped is no better than one that hides it.
 */
export function skippedLanguages(root: string, paths: string[]): Map<string, number> {
  const skipped = new Map<string, number>();
  testFiles(root, paths, skipped);
  return skipped;
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

/**
 * The one line that keeps the count above honest on a project Tewip half-reads.
 *
 * Only ever says what it skipped and that it skipped it. It does not guess how many were tests -
 * naming conventions differ per language, and a count that overstates what was missed is no better
 * than one that hides it.
 */
function skippedLine(skipped: Map<string, number>): string[] {
  const rows = [...skipped.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return [];
  const [first, ...rest] = rows;
  const also = rest.slice(0, 2).map(([name, n]) => `${n} ${name}`);
  return [
    '',
    `**It did not read ${first[1]} ${first[0]} file(s)**${also.length > 0 ? ` (also ${also.join(', ')})` : ''}, because Tewip cannot read ${first[0]}. ` +
      `Any tests in them are not in the count above and have not been judged either way.`,
  ];
}

const count = (all: Judgement[], verdict: Verdict): number => all.filter((j) => j.verdict === verdict).length;

export function renderVouch(files: FileVouch[], skipped: Map<string, number> = new Map()): string {
  // No test file was read, so there is nothing to say about tests.
  //
  // This printed the ordinary summary - "0 test(s) read in 0 file(s). **0 cannot fail at all.**" -
  // followed by the heading **"Nothing here is unable to fail"** and the line "Every test read can
  // be broken by a change to the code". All true of nothing, and all of it reads as a pass, in the
  // command whose entire job is to find tests that cannot fail.
  //
  // The comment in `testFilesUnder` above already diagnosed this in Phase 36, when three languages
  // were missing from the extension list and a file named outright came back as "0 test(s) read in
  // 0 file(s) - which reads like a clean answer and is not one". The cause was fixed; the report
  // was not, so every other way of reading nothing still produced a pass: the wrong folder, a
  // framework Tewip does not recognise, or a project that genuinely has no tests yet.
  if (files.length === 0) {
    return [
      '# Which of these tests could fail?',
      '',
      '**No test file was read, so nothing here has been checked.** This is not a report that your tests are sound - it is a report that Tewip found none to look at.',
      '',
      'Three things usually explain it: the path given holds no tests, the tests are somewhere Tewip was not pointed at (`tewip vouch <path>`), or they are written in a language it cannot read yet.',
      '',
      'It reads JavaScript, TypeScript, Python, Java, Kotlin, Scala, Groovy, Go, C#, F#, Ruby, PHP and Rust.',
      '',
    ].join(String.fromCharCode(10));
  }
  const all = files.flatMap((f) => f.judgements);
  const cannotFail = all.filter((j) => CANNOT_FAIL.includes(j.verdict));
  const crashOnly = count(all, 'crash-only');
  const lines = [
    '# Which of these tests could fail?',
    '',
    `${all.length} test(s) read in ${files.length} file(s). **${cannotFail.length} cannot fail at all.** ${crashOnly} compare no value, so only a crash would fail them. ${count(all, 'cannot-tell')} Tewip would not judge.`,
    // Phase 186. Said next to the count, not in a footnote, because it is the count that is
    // misleading without it: on a clone of the Flutter SDK this line read "1088 test(s) read in 112
    // file(s)" for a repository of 2,743 Dart test files, and the verdict covered the Android
    // corner written in Java. A number that describes a corner of a project, printed as though it
    // described the project, is the thing this whole command exists to stop happening to tests.
    ...skippedLine(skipped),
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
