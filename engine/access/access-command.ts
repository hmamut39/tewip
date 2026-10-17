// Phase 28: `tewip access` - the accessibility barriers that can be proved by reading the markup,
// separated from the questions only a person can answer, with everything it did not check named.
//
// Why this exists when axe, Lighthouse and pa11y already do: those tools hand a team a few hundred
// undifferentiated violations, a large share of which are not barriers at all, and the team turns
// the check off. Tewip makes exactly two kinds of statement - "this stops somebody, here is the
// element" and "only you can settle this one" - and prints the criteria it cannot reach. It needs
// no browser, no server, no network and no model, so it runs on any repository in a second.
//
// It never says a page is accessible. It says what was checked.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { normalise } from '../quality/source-text.ts';
import { dirname, join, relative, resolve } from 'node:path';
import { sourceFiles } from '../secure/secrets.ts';
import { readHandWritten } from '../../reporters/store.ts';
import { JS_LIKE, MARKUP, tags } from './markup.ts';
import { checkFile, type Finding } from './checks.ts';
import { readAxeReport, type AxeRun, type BrowserFinding } from './reports.ts';
import { isLighthouseFile, readLighthouse } from '../perf/lighthouse.ts';
import { accessibilityFromLighthouse, criteriaFromLighthouse, rulesRunByLighthouse } from './from-lighthouse.ts';
import { merge, pagesIn } from './merge.ts';
import { renderAccess, worstFirst } from './render.ts';

// Re-exported so callers do not have to know the report moved into its own file.
export { renderAccess, worstFirst };
import { blocks } from './wcag.ts';

export interface AccessCommand {
  root: string;
  out?: string;
  /** Exit non-zero when a barrier is found, for a CI gate. */
  gate?: boolean;
  /** Only this file or directory, rather than the whole repository. */
  only?: string;
  /**
   * An axe run's JSON (Phase 29) or a Lighthouse report (Phase 32), which settles what reading
   * markup cannot. Tewip works out which it was handed.
   */
  report?: string;
}

export interface AccessResult {
  barriers: Finding[];
  questions: Finding[];
  accepted: Finding[];
  filesRead: number;
  report: string;
  /** Phase 29, when a browser run was given. */
  browser?: {
    barriers: BrowserFinding[];
    questions: BrowserFinding[];
    advice: BrowserFinding[];
    /** Source findings the run supersedes, because it re-checked them on a real page. */
    superseded: Finding[];
    pages: string[];
    /** Every axe rule that ran, whatever its outcome: what the run can be said to have checked. */
    rulesRun: Set<string>;
    /** Which tool was actually run, so the report names it rather than always saying axe. */
    tool: 'axe' | 'lighthouse';
  };
}


/** One line per finding a person has already judged: "<rule> <file>:<line> - reason". */
export function readAccepted(root: string): Set<string> {
  const file = join(root, '.tewip', 'access-accepted.txt');
  if (!existsSync(file)) return new Set();
  return new Set(
    readHandWritten(file)
      .split('\n')
      .map((l) => l.split(' - ')[0].trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
}

export function keyOf(f: Finding): string {
  return `${f.rule} ${f.file}:${f.line}`;
}


/** Reads every markup file under `root` and returns what the markup alone can settle. */
/**
 * Markup written to exercise code, not to be used by a person. An `<img>` with no alt in a
 * clipboard test is not a barrier to anybody, and excalidraw's test suite produced exactly that.
 */
const TEST_MARKUP = /(?:^|[\\/])(?:__tests__|__mocks__|tests?|spec|e2e|stories|fixtures?)[\\/]|\.(?:test|spec|stories|cy)\.[cm]?[jt]sx?$/i;

export function findBarriers(root: string, only?: string): { findings: Finding[]; filesRead: number } {
  const base = only ? resolve(root, only) : root;
  const all = existsSync(base) && MARKUP.test(base) ? [base] : sourceFiles(base).filter((f) => MARKUP.test(f));
  // Asking for a path by name overrides the exclusion: if you point at a fixture, you want it read.
  const files = only ? all : all.filter((f) => !TEST_MARKUP.test(relative(root, f)));
  const findings: Finding[] = [];
  let filesRead = 0;
  for (const path of files) {
    let source: string;
    try {
      source = normalise(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    // A file too large to be hand-written is generated or minified, and accusing it helps nobody.
    if (source.length > 400_000) continue;
    filesRead++;
    const jsLike = JS_LIKE.test(path);
    // One page, rather than a file of components: only then do repeated ids land in one document.
    const isDocument = /\.html?$/i.test(path);
    findings.push(...checkFile(source, tags(source, jsLike), relative(root, path).replaceAll('\\', '/'), isDocument));
  }
  return { findings, filesRead };
}

/**
 * Reads whichever browser evidence the team actually has.
 *
 * axe and Lighthouse are the same rules - Lighthouse runs axe - so both become one shape and are
 * triaged identically. A team with Lighthouse in CI and no separate axe step gets the same answers
 * without adding a tool (Phase 32).
 */
export function readBrowserRun(path: string): AxeRun {
  if (!isLighthouseFile(path)) return readAxeReport(path);
  const report = readLighthouse(path);
  return {
    source: 'lighthouse',
    findings: accessibilityFromLighthouse(report),
    pages: new Set(report.url === '' ? [] : [report.url]),
    rulesRun: rulesRunByLighthouse(report),
    criteriaCovered: criteriaFromLighthouse(report),
  };
}

export function runAccess(cmd: AccessCommand): AccessResult {
  const root = resolve(cmd.root);
  const { findings, filesRead } = findBarriers(root, cmd.only);
  const alreadyJudged = readAccepted(root);

  const accepted = findings.filter((f) => alreadyJudged.has(keyOf(f)));
  const open = findings.filter((f) => !alreadyJudged.has(keyOf(f)));

  // Phase 29: a browser run, where one was given. It is the better witness for every criterion it
  // checked, so the source findings for those criteria are set aside rather than repeated.
  const run = cmd.report ? readBrowserRun(resolve(root, cmd.report)) : undefined;
  const graded = run ? merge(open, run, root) : undefined;
  const kept = graded ? graded.kept : open;

  const barriers = kept.filter((f) => f.confidence === 'barrier');
  const questions = kept.filter((f) => f.confidence === 'ask-a-person');

  const browser =
    run && graded
      ? {
          barriers: run.findings.filter((f) => f.confidence === 'barrier'),
          questions: run.findings.filter((f) => f.confidence === 'ask-a-person'),
          advice: run.findings.filter((f) => f.confidence === 'advice'),
          superseded: graded.superseded,
          pages: pagesIn(run),
          rulesRun: run.rulesRun,
          tool: run.source,
        }
      : undefined;

  const result = { barriers, questions, accepted, filesRead, ...(browser ? { browser } : {}) };
  const report = renderAccess(result, cmd.only ? resolve(root, cmd.only) : root);
  console.log(report);

  // What fails a build is deliberately narrower than what gets reported. A question never fails it:
  // a build that breaks because something needs a human decision teaches a team to stop asking. Nor
  // does a moderate finding - bootstrap's example pages skip a heading level, which is worth knowing
  // and not worth blocking a release over. Only the barriers that stop somebody outright.
  // A browser barrier counts the same way: axe saw it on a rendered page, which is stronger
  // evidence than reading source, not weaker. Advice never counts, whatever axe's impact says.
  const blocking = barriers.filter((f) => blocks(f.rule)).length + (browser?.barriers.filter((f) => f.severity === 'blocker').length ?? 0);
  if (cmd.gate && blocking > 0) {
    const found = barriers.length + (browser?.barriers.length ?? 0);
    console.error(`${String.fromCharCode(10)}${blocking} accessibility barrier(s) that stop somebody outright, out of ${found} found.`);
    process.exitCode = 1;
  }

  if (cmd.out) {
    const path = resolve(root, cmd.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report, 'utf8');
    writeFileSync(path.replace(/\.md$/, '') + '.json', JSON.stringify({ barriers, questions, accepted, filesRead }, null, 2), 'utf8');
  }

  return { ...result, report };
}
